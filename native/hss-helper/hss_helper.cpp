#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <cmath>
#include <cctype>
#include <cstdlib>
#include <cwctype>
#include <cstdint>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#ifndef HSS_HELPER_VERSION
#define HSS_HELPER_VERSION "1"
#endif

#ifndef HSS_HELPER_PROTOCOL_VERSION
#define HSS_HELPER_PROTOCOL_VERSION 1
#endif

using U8 = std::uint8_t;
using U16 = std::uint16_t;
using U32 = std::uint32_t;

struct JLINK_HSS_MEM_BLOCK_DESC {
  U32 Addr;
  U32 NumBytes;
  U32 Flags;
  U32 Dummy;
};

struct JLINK_HSS_CAPS {
  U32 MaxBlocks;
  U32 MaxFreq;
  U32 Caps;
  U32 aDummy[5];
};

using JLINK_HSS_GetCaps_Fn = int (*)(JLINK_HSS_CAPS*);
using JLINK_HSS_Start_Fn = int (*)(JLINK_HSS_MEM_BLOCK_DESC*, U32, U32);
using JLINK_HSS_Read_Fn = int (*)(void*, U32);
using JLINK_HSS_Stop_Fn = int (*)();
using JLINKARM_Open_Fn = int (*)();
using JLINKARM_Close_Fn = void (*)();
using JLINKARM_ExecCommand_Fn = int (*)(const char*, char*, int);
using JLINKARM_TIF_Select_Fn = int (*)(int);
using JLINKARM_SetSpeed_Fn = void (*)(int);
using JLINKARM_Connect_Fn = int (*)();
using JLINKARM_EMU_SelectByUSBSN_Fn = int (*)(U32);
using JLINKARM_GetDLLVersion_Fn = int (*)();
using JLINKARM_GetSN_Fn = U32 (*)();
using JLINKARM_GetId_Fn = U32 (*)();
using JLINKARM_IsHalted_Fn = int (*)();
using JLINKARM_Go_Fn = void (*)();
using JLINKARM_Halt_Fn = void (*)();
using JLINKARM_Reset_Fn = void (*)();
using JLINKARM_ReadMem_Fn = int (*)(U32, U32, void*);
using JLINKARM_WriteMem_Fn = int (*)(U32, U32, const void*);
using JLINKARM_ReadMemU8_Fn = int (*)(U32, U32, U8*, U8*);
using JLINKARM_ReadMemU16_Fn = int (*)(U32, U32, U16*, U8*);
using JLINKARM_ReadMemU32_Fn = int (*)(U32, U32, U32*, U8*);
using JLINKARM_WriteU8_Fn = void (*)(U32, U8);
using JLINKARM_WriteU16_Fn = void (*)(U32, U16);
using JLINKARM_WriteU32_Fn = void (*)(U32, U32);

static bool suppress_jlink_gui(JLINKARM_ExecCommand_Fn arm_exec, bool* crashed);

static std::string narrow(const std::wstring& input) {
  if (input.empty()) return "";
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.c_str(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return "";
  std::string output(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.c_str(), static_cast<int>(input.size()), output.data(), size, nullptr, nullptr) != size) return "";
  return output;
}

static bool widen_utf8(const std::string& input, std::wstring* output) {
  if (input.empty()) return false;
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), nullptr, 0);
  if (size <= 0) return false;
  output->assign(static_cast<size_t>(size), L'\0');
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()), output->data(), size) == size
    && narrow(*output) == input;
}

static std::string escape(const std::string& input) {
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (unsigned char ch : input) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20U) out << "\\u00" << std::setw(2) << static_cast<unsigned>(ch);
        else out << static_cast<char>(ch);
        break;
    }
  }
  return out.str();
}

static std::map<std::wstring, std::wstring> parse_options(int argc, wchar_t** argv) {
  std::map<std::wstring, std::wstring> options;
  for (int i = 2; i + 1 < argc; i += 2) {
    options[argv[i]] = argv[i + 1];
  }
  return options;
}

static void error_json(const std::string& code, const std::string& reason, const std::string& dll = "") {
  std::cout
    << "{\"status\":\"error\",\"errorCode\":\"" << escape(code)
    << "\",\"reason\":\"" << escape(reason)
    << "\",\"dll\":\"" << escape(dll)
    << "\",\"helperVersion\":\"" << HSS_HELPER_VERSION
    << "\",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
}

static bool valid_sha256_hex(const std::string& value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](unsigned char ch) { return std::isxdigit(ch) != 0; });
}

static bool sha256_handle(HANDLE input, std::string* sha256) {
  if (input == INVALID_HANDLE_VALUE || SetFilePointer(input, 0, nullptr, FILE_BEGIN) == INVALID_SET_FILE_POINTER && GetLastError() != NO_ERROR) return false;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0;
  DWORD hash_bytes = 0;
  DWORD result_bytes = 0;
  bool ok = BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0
    && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &result_bytes, 0) >= 0
    && BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_bytes), sizeof(hash_bytes), &result_bytes, 0) >= 0
    && hash_bytes == 32;
  std::vector<U8> object(object_bytes);
  std::vector<U8> digest(hash_bytes);
  if (ok) ok = BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) >= 0;
  std::vector<U8> buffer(64 * 1024);
  while (ok) {
    DWORD bytes_read = 0;
    if (!ReadFile(input, buffer.data(), static_cast<DWORD>(buffer.size()), &bytes_read, nullptr)) {
      ok = false;
      break;
    }
    if (bytes_read == 0) break;
    ok = BCryptHashData(hash, buffer.data(), bytes_read, 0) >= 0;
  }
  if (ok) ok = BCryptFinishHash(hash, digest.data(), hash_bytes, 0) >= 0;
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!ok) return false;
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (U8 byte : digest) out << std::setw(2) << static_cast<unsigned>(byte);
  *sha256 = out.str();
  return true;
}

static bool sha256_file(const std::wstring& file, std::string* sha256) {
  HANDLE input = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (input == INVALID_HANDLE_VALUE) return false;
  const bool ok = sha256_handle(input, sha256);
  CloseHandle(input);
  return ok;
}

static bool sha256_bytes(const std::string& bytes, std::string* sha256) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_bytes = 0;
  DWORD hash_bytes = 0;
  DWORD result_bytes = 0;
  bool ok = bytes.size() <= (std::numeric_limits<ULONG>::max)()
    && BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0
    && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_bytes), sizeof(object_bytes), &result_bytes, 0) >= 0
    && BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_bytes), sizeof(hash_bytes), &result_bytes, 0) >= 0
    && hash_bytes == 32;
  std::vector<U8> object(object_bytes);
  std::vector<U8> digest(hash_bytes);
  if (ok) ok = BCryptCreateHash(algorithm, &hash, object.data(), object_bytes, nullptr, 0, 0) >= 0;
  if (ok) ok = BCryptHashData(hash, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())), static_cast<ULONG>(bytes.size()), 0) >= 0;
  if (ok) ok = BCryptFinishHash(hash, digest.data(), hash_bytes, 0) >= 0;
  if (hash) BCryptDestroyHash(hash);
  if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!ok) return false;
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (U8 byte : digest) out << std::setw(2) << static_cast<unsigned>(byte);
  *sha256 = out.str();
  return true;
}

static int version() {
  std::cout << "{\"status\":\"ok\",\"helperVersion\":\"" << HSS_HELPER_VERSION
            << "\",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION << "}";
  return 0;
}

static FARPROC required(HMODULE dll, const char* name) {
  return GetProcAddress(dll, name);
}

static int call_getcaps(JLINK_HSS_GetCaps_Fn fn, JLINK_HSS_CAPS* caps, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(caps);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_int0(int (*fn)(), bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn();
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static U32 call_u320(U32 (*fn)(), bool* crashed) {
  U32 return_code = 0;
  *crashed = false;
  __try {
    return_code = fn();
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static void call_void0(void (*fn)(), bool* crashed) {
  *crashed = false;
  __try {
    fn();
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
}

static int call_int1(int (*fn)(int), int arg, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(arg);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static void call_void1(void (*fn)(int), int arg, bool* crashed) {
  *crashed = false;
  __try {
    fn(arg);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
}

static int call_select_sn(JLINKARM_EMU_SelectByUSBSN_Fn fn, U32 serial, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(serial);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_exec(JLINKARM_ExecCommand_Fn fn, const char* command, char* out, int out_size, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(command, out, out_size);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_hss_start(JLINK_HSS_Start_Fn fn, JLINK_HSS_MEM_BLOCK_DESC* blocks, U32 count, U32 period_us, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(blocks, count, period_us);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_hss_read(JLINK_HSS_Read_Fn fn, void* data, U32 size, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(data, size);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_hss_stop(JLINK_HSS_Stop_Fn fn, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn();
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_read_mem(JLINKARM_ReadMem_Fn fn, U32 address, U32 size, void* data, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(address, size, data);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_write_mem(JLINKARM_WriteMem_Fn fn, U32 address, U32 size, const void* data, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(address, size, data);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_read_mem_u8(JLINKARM_ReadMemU8_Fn fn, U32 address, U32 count, U8* data, U8* status, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(address, count, data, status);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_read_mem_u16(JLINKARM_ReadMemU16_Fn fn, U32 address, U32 count, U16* data, U8* status, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(address, count, data, status);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static int call_read_mem_u32(JLINKARM_ReadMemU32_Fn fn, U32 address, U32 count, U32* data, U8* status, bool* crashed) {
  int return_code = 0;
  *crashed = false;
  __try {
    return_code = fn(address, count, data, status);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
  return return_code;
}

static void call_write_u8(JLINKARM_WriteU8_Fn fn, U32 address, U8 data, bool* crashed) {
  *crashed = false;
  __try {
    fn(address, data);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
}

static void call_write_u16(JLINKARM_WriteU16_Fn fn, U32 address, U16 data, bool* crashed) {
  *crashed = false;
  __try {
    fn(address, data);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
}

static void call_write_u32(JLINKARM_WriteU32_Fn fn, U32 address, U32 data, bool* crashed) {
  *crashed = false;
  __try {
    fn(address, data);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    *crashed = true;
  }
}

static int64_t now_ns() {
  LARGE_INTEGER counter{};
  LARGE_INTEGER frequency{};
  QueryPerformanceCounter(&counter);
  QueryPerformanceFrequency(&frequency);
  return static_cast<int64_t>((static_cast<long double>(counter.QuadPart) * 1000000000.0L) / static_cast<long double>(frequency.QuadPart));
}

static int64_t qpc_counter() {
  LARGE_INTEGER counter{};
  return QueryPerformanceCounter(&counter) ? counter.QuadPart : -1;
}

static bool query_qpc_timebase(int64_t* counter, int64_t* frequency) {
  LARGE_INTEGER qpc_frequency{};
  LARGE_INTEGER qpc_counter_value{};
  if (!QueryPerformanceFrequency(&qpc_frequency) || qpc_frequency.QuadPart <= 0
      || !QueryPerformanceCounter(&qpc_counter_value) || qpc_counter_value.QuadPart < 0) return false;
  *counter = qpc_counter_value.QuadPart;
  *frequency = qpc_frequency.QuadPart;
  return true;
}

static bool parse_qpc_decimal(const std::string& text, int64_t* value) {
  if (text.empty() || !std::all_of(text.begin(), text.end(), [](unsigned char ch) { return std::isdigit(ch) != 0; })) return false;
  try {
    size_t consumed = 0;
    const auto parsed = std::stoull(text, &consumed, 10);
    if (consumed != text.size() || parsed > static_cast<uint64_t>((std::numeric_limits<int64_t>::max)())) return false;
    *value = static_cast<int64_t>(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

static bool qpc_delta_ns(int64_t counter, int64_t epoch, int64_t frequency, uint64_t* tick) {
  if (counter < epoch || epoch < 0 || frequency <= 0) return false;
  const long double value = static_cast<long double>(counter - epoch) * 1000000000.0L / static_cast<long double>(frequency);
  if (value < 0 || value > static_cast<long double>((std::numeric_limits<uint64_t>::max)())) return false;
  *tick = static_cast<uint64_t>(value);
  return true;
}

static int qpc_timebase() {
  int64_t counter = 0;
  int64_t frequency = 0;
  if (!query_qpc_timebase(&counter, &frequency)) {
    error_json("HSS_QPC_UNAVAILABLE", "QueryPerformanceCounter timebase is unavailable");
    return 0;
  }
  std::cout << "{\"status\":\"ok\",\"command\":\"qpc-timebase\",\"qpcCounter\":\"" << counter
            << "\",\"qpcFrequency\":\"" << frequency
            << "\",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return 0;
}

static int64_t sample_due_ns(int64_t started_ns, uint64_t sample, int requested_rate) {
  return started_ns + static_cast<int64_t>((sample + 1U) * 1000000000ULL / static_cast<uint64_t>(requested_rate));
}

static std::string read_text_file(const std::wstring& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return "";
  std::ostringstream out;
  out << file.rdbuf();
  return out.str();
}

static std::string json_string(const std::string& text, const char* name, const char* fallback = "") {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) return std::string(fallback);
  const std::string encoded = match[1].str();
  std::string decoded;
  decoded.reserve(encoded.size());
  for (size_t index = 0; index < encoded.size(); ++index) {
    const char ch = encoded[index];
    if (ch != '\\') {
      decoded.push_back(ch);
      continue;
    }
    if (++index >= encoded.size()) return std::string(fallback);
    switch (encoded[index]) {
      case '\"': decoded.push_back('\"'); break;
      case '\\': decoded.push_back('\\'); break;
      case '/': decoded.push_back('/'); break;
      case 'b': decoded.push_back('\b'); break;
      case 'f': decoded.push_back('\f'); break;
      case 'n': decoded.push_back('\n'); break;
      case 'r': decoded.push_back('\r'); break;
      case 't': decoded.push_back('\t'); break;
      default: return std::string(fallback);
    }
  }
  return decoded;
}

static int json_int(const std::string& text, const char* name, int fallback = 0) {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*(\\d+)");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? std::stoi(match[1].str()) : fallback;
}

static double json_double(const std::string& text, const char* name, double fallback = 0.0) {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*(\\d+(?:\\.\\d+)?)");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? std::stod(match[1].str()) : fallback;
}

static bool json_bool(const std::string& text, const char* name, bool fallback = false) {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*(true|false)");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? match[1].str() == "true" : fallback;
}

struct StrictJson {
  enum class Type { nullValue, boolean, number, string, object, array } type = Type::nullValue;
  bool booleanValue = false;
  std::string text;
  std::map<std::string, StrictJson> objectValue;
  std::vector<StrictJson> arrayValue;
};

static bool valid_utf8(const std::string& value) {
  if (value.empty()) return true;
  const int wide_size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (wide_size <= 0) return false;
  std::wstring wide(static_cast<size_t>(wide_size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), wide.data(), wide_size) != wide_size) return false;
  return narrow(wide) == value;
}

static void append_utf8_codepoint(uint32_t codepoint, std::string* out) {
  if (codepoint <= 0x7FU) out->push_back(static_cast<char>(codepoint));
  else if (codepoint <= 0x7FFU) {
    out->push_back(static_cast<char>(0xC0U | (codepoint >> 6U)));
    out->push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
  } else if (codepoint <= 0xFFFFU) {
    out->push_back(static_cast<char>(0xE0U | (codepoint >> 12U)));
    out->push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
    out->push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
  } else {
    out->push_back(static_cast<char>(0xF0U | (codepoint >> 18U)));
    out->push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3FU)));
    out->push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
    out->push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
  }
}

static bool canonical_json_number_token(const std::string& token) {
  if (token == "-0") return false;
  const size_t e = token.find_first_of("eE");
  if (e != std::string::npos && token[e] != 'e') return false;
  const size_t dot = token.find('.');
  if (dot != std::string::npos) {
    const size_t fraction_end = e == std::string::npos ? token.size() : e;
    if (fraction_end <= dot + 1U || token[fraction_end - 1U] == '0') return false;
  }
  if (e != std::string::npos) {
    size_t exponent = e + 1U;
    if (exponent < token.size() && (token[exponent] == '+' || token[exponent] == '-')) ++exponent;
    if (exponent >= token.size() || (token[exponent] == '0' && exponent + 1U < token.size())) return false;
  }
  char* end = nullptr;
  const double value = std::strtod(token.c_str(), &end);
  if (!end || *end != '\0' || !std::isfinite(value)) return false;
  const double magnitude = std::fabs(value);
  if (e != std::string::npos && magnitude >= 1e-6 && magnitude < 1e21) return false;
  if (e == std::string::npos && magnitude != 0.0 && (magnitude < 1e-6 || magnitude >= 1e21)) return false;
  return true;
}

class StrictJsonParser {
 public:
  explicit StrictJsonParser(const std::string& input) : input_(input) {}

  bool parse(StrictJson* value, std::string* reason) {
    skip_space();
    if (!parse_value(value, reason)) return false;
    skip_space();
    if (position_ != input_.size()) { *reason = "JSON has trailing content"; return false; }
    return true;
  }

 private:
  const std::string& input_;
  size_t position_ = 0;

  void skip_space() {
    while (position_ < input_.size() && (input_[position_] == ' ' || input_[position_] == '\t' || input_[position_] == '\r' || input_[position_] == '\n')) ++position_;
  }

  bool parse_value(StrictJson* value, std::string* reason) {
    if (position_ >= input_.size()) { *reason = "JSON value is missing"; return false; }
    if (input_[position_] == '{') return parse_object(value, reason);
    if (input_[position_] == '[') return parse_array(value, reason);
    if (input_[position_] == '"') {
      value->type = StrictJson::Type::string;
      return parse_string(&value->text, reason);
    }
    if (input_.compare(position_, 4U, "true") == 0) { position_ += 4U; value->type = StrictJson::Type::boolean; value->booleanValue = true; return true; }
    if (input_.compare(position_, 5U, "false") == 0) { position_ += 5U; value->type = StrictJson::Type::boolean; value->booleanValue = false; return true; }
    if (input_.compare(position_, 4U, "null") == 0) { position_ += 4U; value->type = StrictJson::Type::nullValue; return true; }
    return parse_number(value, reason);
  }

  bool parse_object(StrictJson* value, std::string* reason) {
    value->type = StrictJson::Type::object;
    ++position_;
    skip_space();
    if (position_ < input_.size() && input_[position_] == '}') { ++position_; return true; }
    for (;;) {
      if (position_ >= input_.size() || input_[position_] != '"') { *reason = "JSON object key is invalid"; return false; }
      std::string key;
      if (!parse_string(&key, reason)) return false;
      skip_space();
      if (position_ >= input_.size() || input_[position_++] != ':') { *reason = "JSON object separator is invalid"; return false; }
      skip_space();
      StrictJson member;
      if (!parse_value(&member, reason)) return false;
      if (!value->objectValue.emplace(key, std::move(member)).second) { *reason = "JSON object contains a duplicate key"; return false; }
      skip_space();
      if (position_ >= input_.size()) { *reason = "JSON object is incomplete"; return false; }
      const char delimiter = input_[position_++];
      if (delimiter == '}') return true;
      if (delimiter != ',') { *reason = "JSON object delimiter is invalid"; return false; }
      skip_space();
    }
  }

  bool parse_array(StrictJson* value, std::string* reason) {
    value->type = StrictJson::Type::array;
    ++position_;
    skip_space();
    if (position_ < input_.size() && input_[position_] == ']') { ++position_; return true; }
    for (;;) {
      StrictJson member;
      if (!parse_value(&member, reason)) return false;
      value->arrayValue.push_back(std::move(member));
      skip_space();
      if (position_ >= input_.size()) { *reason = "JSON array is incomplete"; return false; }
      const char delimiter = input_[position_++];
      if (delimiter == ']') return true;
      if (delimiter != ',') { *reason = "JSON array delimiter is invalid"; return false; }
      skip_space();
    }
  }

  static int hex_digit(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
  }

  bool parse_hex4(uint32_t* value) {
    if (position_ + 4U > input_.size()) return false;
    *value = 0;
    for (size_t index = 0; index < 4U; ++index) {
      const int digit = hex_digit(input_[position_++]);
      if (digit < 0) return false;
      *value = (*value << 4U) | static_cast<uint32_t>(digit);
    }
    return true;
  }

  bool parse_string(std::string* value, std::string* reason) {
    if (input_[position_++] != '"') return false;
    value->clear();
    while (position_ < input_.size()) {
      const unsigned char ch = static_cast<unsigned char>(input_[position_++]);
      if (ch == '"') {
        if (!valid_utf8(*value)) { *reason = "JSON string is not valid UTF-8"; return false; }
        return true;
      }
      if (ch < 0x20U) { *reason = "JSON string contains an unescaped control byte"; return false; }
      if (ch != '\\') { value->push_back(static_cast<char>(ch)); continue; }
      if (position_ >= input_.size()) { *reason = "JSON string escape is incomplete"; return false; }
      const char escaped = input_[position_++];
      switch (escaped) {
        case '"': value->push_back('"'); break;
        case '\\': value->push_back('\\'); break;
        case '/': value->push_back('/'); break;
        case 'b': value->push_back('\b'); break;
        case 'f': value->push_back('\f'); break;
        case 'n': value->push_back('\n'); break;
        case 'r': value->push_back('\r'); break;
        case 't': value->push_back('\t'); break;
        case 'u': {
          uint32_t first = 0;
          if (!parse_hex4(&first)) { *reason = "JSON unicode escape is invalid"; return false; }
          uint32_t codepoint = first;
          if (first >= 0xD800U && first <= 0xDBFFU) {
            if (position_ + 6U > input_.size() || input_[position_] != '\\' || input_[position_ + 1U] != 'u') { *reason = "JSON surrogate pair is incomplete"; return false; }
            position_ += 2U;
            uint32_t second = 0;
            if (!parse_hex4(&second) || second < 0xDC00U || second > 0xDFFFU) { *reason = "JSON surrogate pair is invalid"; return false; }
            codepoint = 0x10000U + ((first - 0xD800U) << 10U) + (second - 0xDC00U);
          } else if (first >= 0xDC00U && first <= 0xDFFFU) { *reason = "JSON low surrogate has no high surrogate"; return false; }
          append_utf8_codepoint(codepoint, value);
          break;
        }
        default: *reason = "JSON string escape is invalid"; return false;
      }
    }
    *reason = "JSON string is incomplete";
    return false;
  }

  bool parse_number(StrictJson* value, std::string* reason) {
    const size_t start = position_;
    if (input_[position_] == '-') ++position_;
    if (position_ >= input_.size()) { *reason = "JSON number is incomplete"; return false; }
    if (input_[position_] == '0') ++position_;
    else {
      if (input_[position_] < '1' || input_[position_] > '9') { *reason = "JSON value is invalid"; return false; }
      while (position_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
    }
    if (position_ < input_.size() && input_[position_] == '.') {
      ++position_;
      const size_t fraction = position_;
      while (position_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
      if (position_ == fraction) { *reason = "JSON fraction is incomplete"; return false; }
    }
    if (position_ < input_.size() && (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() && (input_[position_] == '+' || input_[position_] == '-')) ++position_;
      const size_t exponent = position_;
      while (position_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[position_]))) ++position_;
      if (position_ == exponent) { *reason = "JSON exponent is incomplete"; return false; }
    }
    value->type = StrictJson::Type::number;
    value->text = input_.substr(start, position_ - start);
    if (!canonical_json_number_token(value->text)) { *reason = "JSON number is not canonical or finite"; return false; }
    return true;
  }
};

static std::string canonical_json_string(const std::string& value) {
  std::ostringstream out;
  out << '"' << std::hex << std::setfill('0');
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20U) out << "\\u00" << std::setw(2) << static_cast<unsigned>(ch);
        else out << static_cast<char>(ch);
        break;
    }
  }
  out << '"';
  return out.str();
}

static std::string canonical_json(const StrictJson& value) {
  if (value.type == StrictJson::Type::nullValue) return "null";
  if (value.type == StrictJson::Type::boolean) return value.booleanValue ? "true" : "false";
  if (value.type == StrictJson::Type::number) return value.text;
  if (value.type == StrictJson::Type::string) return canonical_json_string(value.text);
  std::ostringstream out;
  if (value.type == StrictJson::Type::array) {
    out << '[';
    for (size_t index = 0; index < value.arrayValue.size(); ++index) {
      if (index) out << ',';
      out << canonical_json(value.arrayValue[index]);
    }
    out << ']';
  } else {
    out << '{';
    bool first = true;
    for (const auto& [key, member] : value.objectValue) {
      if (!first) out << ',';
      first = false;
      out << canonical_json_string(key) << ':' << canonical_json(member);
    }
    out << '}';
  }
  return out.str();
}

static const StrictJson* json_member(const StrictJson& value, const char* key) {
  if (value.type != StrictJson::Type::object) return nullptr;
  const auto found = value.objectValue.find(key);
  return found == value.objectValue.end() ? nullptr : &found->second;
}

static bool json_exact_keys(const StrictJson& value, std::initializer_list<const char*> keys) {
  if (value.type != StrictJson::Type::object || value.objectValue.size() != keys.size()) return false;
  for (const char* key : keys) if (!value.objectValue.count(key)) return false;
  return true;
}

static bool json_text(const StrictJson* value, std::string* out) {
  if (!value || value->type != StrictJson::Type::string) return false;
  *out = value->text;
  return true;
}

static bool json_true(const StrictJson* value) { return value && value->type == StrictJson::Type::boolean && value->booleanValue; }

static bool json_u64(const StrictJson* value, uint64_t* out) {
  if (!value || value->type != StrictJson::Type::number || !std::regex_match(value->text, std::regex("0|[1-9][0-9]*"))) return false;
  try {
    size_t consumed = 0;
    const uint64_t parsed = std::stoull(value->text, &consumed, 10);
    if (consumed != value->text.size() || parsed > 9007199254740991ULL) return false;
    *out = parsed;
    return true;
  } catch (...) { return false; }
}

static bool lower_sha256(const std::string& value) {
  return value.size() == 64U && std::all_of(value.begin(), value.end(), [](unsigned char ch) { return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); });
}

static bool bounded_text(const std::string& value) {
  return !value.empty() && value.size() <= 1024U && !std::isspace(static_cast<unsigned char>(value.front())) && !std::isspace(static_cast<unsigned char>(value.back()));
}

static bool iso_utc_milliseconds(const std::string& value) {
  return std::regex_match(value, std::regex("[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z"));
}

static bool uuid_v4(const std::string& value) {
  return std::regex_match(value, std::regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"));
}

static std::string hex_u32(U32 value);
static std::wstring lower_path(std::wstring path);

struct R4CommandBindings {
  std::string planPath;
  std::string expectedSummarySha256;
  std::string device;
  std::string iface;
  std::string serial;
  int speedKhz = 0;
  std::string captureId;
  std::string runtimeIdentitySha256;
  std::string artifactGeneration;
  std::string artifactSha256;
  std::string address;
  int length = 0;
  int accessSize = 0;
  std::string bytesHex;
  bool enforcePlanPath = true;
};

struct R4NativeException {
  std::string summarySha256;
  std::string writePlanId;
  std::string canonicalTarget;
  std::string bytesHex;
  U32 address = 0;
  int byteLength = 0;
  int accessSize = 0;
};

static bool r4_compute_approval_digest(const StrictJson& envelope, std::string* digest, std::string* reason) {
  const StrictJson* operation = json_member(envelope, "operation");
  const StrictJson* approval = json_member(envelope, "approval");
  const StrictJson* binding = json_member(envelope, "binding");
  const StrictJson* target = binding ? json_member(*binding, "target") : nullptr;
  const StrictJson* probe = binding ? json_member(*binding, "probe") : nullptr;
  const StrictJson* artifact = binding ? json_member(*binding, "artifact") : nullptr;
  const StrictJson* policy = binding ? json_member(*binding, "policy") : nullptr;
  const StrictJson* session = binding ? json_member(*binding, "session") : nullptr;
  std::string write_plan_id, target_id, artifact_match, probe_kind, serial, iface, generation, artifact_sha, layout, policy_sha, session_id, capture_id;
  uint64_t speed = 0, connection = 0;
  if (!operation || !approval || !binding || !target || !probe || !artifact || !policy || !session
      || !json_text(json_member(*operation, "writePlanId"), &write_plan_id)
      || !json_text(json_member(*target, "targetId"), &target_id) || !json_text(json_member(*target, "artifactMatch"), &artifact_match)
      || !json_text(json_member(*probe, "kind"), &probe_kind) || !json_text(json_member(*probe, "serial"), &serial)
      || !json_text(json_member(*probe, "interface"), &iface) || !json_u64(json_member(*probe, "speedKhz"), &speed)
      || !json_text(json_member(*artifact, "generation"), &generation) || !json_text(json_member(*artifact, "sha256"), &artifact_sha)
      || !json_text(json_member(*binding, "layoutSha256"), &layout) || !json_text(json_member(*policy, "sha256"), &policy_sha)
      || !json_text(json_member(*session, "id"), &session_id) || !json_text(json_member(*session, "captureId"), &capture_id)
      || !json_u64(json_member(*binding, "physicalConnectionGeneration"), &connection)) {
    *reason = "R4 approval binding is incomplete";
    return false;
  }
  const std::string canonical =
    "{\"artifact\":{\"generation\":" + canonical_json_string(generation) + ",\"sha256\":" + canonical_json_string(artifact_sha)
    + "},\"canonicalArgs\":{\"writePlanId\":" + canonical_json_string(write_plan_id)
    + "},\"connectionGeneration\":" + std::to_string(connection)
    + ",\"layoutHash\":" + canonical_json_string(layout)
    + ",\"policy\":{\"sha256\":" + canonical_json_string(policy_sha) + ",\"unverifiedWriteException\":true}"
    + ",\"probe\":{\"interface\":" + canonical_json_string(iface) + ",\"kind\":" + canonical_json_string(probe_kind)
    + ",\"serial\":" + canonical_json_string(serial) + ",\"speedKhz\":" + std::to_string(speed) + "}"
    + ",\"session\":{\"captureId\":" + canonical_json_string(capture_id) + ",\"id\":" + canonical_json_string(session_id) + "}"
    + ",\"target\":{\"artifactMatch\":" + canonical_json_string(artifact_match) + ",\"targetId\":" + canonical_json_string(target_id) + "}"
    + ",\"tool\":\"variable_write_execute\"}";
  if (!sha256_bytes(canonical, digest)) {
    *reason = "R4 approval operation digest could not be computed";
    return false;
  }
  return true;
}

static bool validate_r4_native_exception(const std::string& bytes, const R4CommandBindings& expected, R4NativeException* out, std::string* reason) {
  StrictJson root;
  if (!valid_utf8(bytes) || !StrictJsonParser(bytes).parse(&root, reason)) return false;
  if (!json_exact_keys(root, {"schema", "version", "kind", "canonicalization", "summaryAlgorithm", "operation", "approval", "binding", "write", "summarySha256"})) { *reason = "R4 envelope contains missing or unknown root fields"; return false; }
  const StrictJson* operation = json_member(root, "operation");
  const StrictJson* approval = json_member(root, "approval");
  const StrictJson* binding = json_member(root, "binding");
  const StrictJson* write = json_member(root, "write");
  if (!operation || !approval || !binding || !write
      || !json_exact_keys(*operation, {"tool", "writePlanId", "planDigest", "planIssuedAt", "planExpiresAt", "canonicalArgs"})
      || !json_exact_keys(*approval, {"state", "challengeId", "operationDigest", "nonceSha256", "consumedAt", "expiresAt"})
      || !json_exact_keys(*binding, {"target", "probe", "runtime", "artifact", "layoutSha256", "policy", "session", "physicalConnectionGeneration"})
      || !json_exact_keys(*write, {"canonicalTarget", "address", "accessSize", "byteLength", "bytesHex", "readbackRequired"})) {
    *reason = "R4 envelope contains missing or unknown nested fields";
    return false;
  }
  const StrictJson* target = json_member(*binding, "target");
  const StrictJson* probe = json_member(*binding, "probe");
  const StrictJson* runtime = json_member(*binding, "runtime");
  const StrictJson* artifact = json_member(*binding, "artifact");
  const StrictJson* policy = json_member(*binding, "policy");
  const StrictJson* session = json_member(*binding, "session");
  const StrictJson* canonical_args = json_member(*operation, "canonicalArgs");
  if (!target || !probe || !runtime || !artifact || !policy || !session || !canonical_args
      || !json_exact_keys(*target, {"targetId", "artifactMatch"})
      || !json_exact_keys(*probe, {"kind", "serial", "interface", "speedKhz"})
      || !json_exact_keys(*runtime, {"identitySha256", "scriptApprovalSha256"})
      || !json_exact_keys(*artifact, {"generation", "sha256", "evidenceGeneration"})
      || !json_exact_keys(*policy, {"sha256", "rule", "unverifiedWriteException", "maxWrites", "remainingWrites", "maxElements", "remainingElements"})
      || !json_exact_keys(*session, {"id", "captureId", "captureGeneration"})
      || !json_exact_keys(*canonical_args, {"targetRef", "canonicalTarget", "values"})) {
    *reason = "R4 envelope binding contains missing or unknown fields";
    return false;
  }
  std::string schema, kind, canonicalization, summary_algorithm, summary, tool, write_plan_id, plan_digest, plan_issued, plan_expires;
  std::string approval_state, challenge_id, approval_digest, nonce_sha, consumed_at, approval_expires;
  std::string target_id, artifact_match, probe_kind, serial, iface, runtime_sha, script_approval_sha, artifact_generation, artifact_sha, evidence_generation;
  std::string layout_sha, policy_sha, policy_rule, session_id, capture_id, canonical_target, bytes_hex, args_target;
  uint64_t version = 0, speed = 0, connection = 0, max_writes = 0, remaining_writes = 0, max_elements = 0, remaining_elements = 0, capture_generation = 0;
  uint64_t address = 0, access_size = 0, byte_length = 0;
  if (!json_text(json_member(root, "schema"), &schema) || !json_u64(json_member(root, "version"), &version)
      || !json_text(json_member(root, "kind"), &kind) || !json_text(json_member(root, "canonicalization"), &canonicalization)
      || !json_text(json_member(root, "summaryAlgorithm"), &summary_algorithm) || !json_text(json_member(root, "summarySha256"), &summary)
      || schema != "jlink-mcp-r4-native-exception" || version != 1U || kind != "unverified_variable_write"
      || canonicalization != "utf8-sorted-json-v1" || summary_algorithm != "sha256") { *reason = "R4 envelope discriminator is invalid"; return false; }
  if (!json_text(json_member(*operation, "tool"), &tool) || tool != "variable_write_execute"
      || !json_text(json_member(*operation, "writePlanId"), &write_plan_id) || !std::regex_match(write_plan_id, std::regex("op_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"))
      || !json_text(json_member(*operation, "planDigest"), &plan_digest) || !lower_sha256(plan_digest)
      || !json_text(json_member(*operation, "planIssuedAt"), &plan_issued) || !json_text(json_member(*operation, "planExpiresAt"), &plan_expires)
      || !iso_utc_milliseconds(plan_issued) || !iso_utc_milliseconds(plan_expires) || plan_issued > plan_expires) { *reason = "R4 operation identity or lifetime is invalid"; return false; }
  if (!json_text(json_member(*approval, "state"), &approval_state) || approval_state != "consumed"
      || !json_text(json_member(*approval, "challengeId"), &challenge_id) || !uuid_v4(challenge_id)
      || !json_text(json_member(*approval, "operationDigest"), &approval_digest) || !lower_sha256(approval_digest)
      || !json_text(json_member(*approval, "nonceSha256"), &nonce_sha) || !lower_sha256(nonce_sha)
      || !json_text(json_member(*approval, "consumedAt"), &consumed_at) || !json_text(json_member(*approval, "expiresAt"), &approval_expires)
      || !iso_utc_milliseconds(consumed_at) || !iso_utc_milliseconds(approval_expires) || consumed_at > approval_expires) { *reason = "R4 approval consumption evidence is invalid"; return false; }
  if (!json_text(json_member(*target, "targetId"), &target_id) || !bounded_text(target_id)
      || !json_text(json_member(*target, "artifactMatch"), &artifact_match) || artifact_match != "unverified"
      || !json_text(json_member(*probe, "kind"), &probe_kind) || probe_kind != "jlink"
      || !json_text(json_member(*probe, "serial"), &serial) || !bounded_text(serial)
      || !json_text(json_member(*probe, "interface"), &iface) || (iface != "SWD" && iface != "JTAG")
      || !json_u64(json_member(*probe, "speedKhz"), &speed) || speed == 0U || speed > (std::numeric_limits<int>::max)()
      || !json_u64(json_member(*binding, "physicalConnectionGeneration"), &connection) || connection == 0U) { *reason = "R4 target or probe binding is invalid"; return false; }
  if (!json_text(json_member(*runtime, "identitySha256"), &runtime_sha) || !lower_sha256(runtime_sha)
      || !json_text(json_member(*runtime, "scriptApprovalSha256"), &script_approval_sha) || !lower_sha256(script_approval_sha)
      || !json_text(json_member(*artifact, "generation"), &artifact_generation) || !lower_sha256(artifact_generation)
      || !json_text(json_member(*artifact, "sha256"), &artifact_sha) || !lower_sha256(artifact_sha)
      || !json_text(json_member(*artifact, "evidenceGeneration"), &evidence_generation) || !lower_sha256(evidence_generation)
      || !json_text(json_member(*binding, "layoutSha256"), &layout_sha) || !lower_sha256(layout_sha)) { *reason = "R4 runtime, Artifact, or layout binding is invalid"; return false; }
  if (!json_text(json_member(*policy, "sha256"), &policy_sha) || !lower_sha256(policy_sha)
      || !json_text(json_member(*policy, "rule"), &policy_rule) || !bounded_text(policy_rule)
      || !json_true(json_member(*policy, "unverifiedWriteException"))
      || !json_u64(json_member(*policy, "maxWrites"), &max_writes) || max_writes == 0U
      || !json_u64(json_member(*policy, "remainingWrites"), &remaining_writes) || remaining_writes > max_writes
      || !json_u64(json_member(*policy, "maxElements"), &max_elements) || max_elements == 0U
      || !json_u64(json_member(*policy, "remainingElements"), &remaining_elements) || remaining_elements > max_elements
      || !json_text(json_member(*session, "id"), &session_id) || !bounded_text(session_id)
      || !json_text(json_member(*session, "captureId"), &capture_id) || !bounded_text(capture_id)
      || !json_u64(json_member(*session, "captureGeneration"), &capture_generation)) { *reason = "R4 policy or session binding is invalid"; return false; }
  if (!json_text(json_member(*write, "canonicalTarget"), &canonical_target) || !bounded_text(canonical_target)
      || !json_u64(json_member(*write, "address"), &address) || address > (std::numeric_limits<U32>::max)()
      || !json_u64(json_member(*write, "accessSize"), &access_size) || (access_size != 1U && access_size != 2U && access_size != 4U)
      || !json_u64(json_member(*write, "byteLength"), &byte_length) || byte_length == 0U || byte_length > 4096U || byte_length % access_size != 0U
      || !json_text(json_member(*write, "bytesHex"), &bytes_hex) || bytes_hex.size() != byte_length * 2U
      || !std::all_of(bytes_hex.begin(), bytes_hex.end(), [](unsigned char ch) { return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); })
      || !json_true(json_member(*write, "readbackRequired")) || address < 0x20000000ULL || address + byte_length > 0x40000000ULL) { *reason = "R4 write binding is invalid or outside the bounded RAM window"; return false; }
  const StrictJson* target_ref = json_member(*canonical_args, "targetRef");
  const StrictJson* values = json_member(*canonical_args, "values");
  std::string ref_kind, ref_path;
  if (!target_ref || !values || values->type != StrictJson::Type::array || values->arrayValue.empty() || values->arrayValue.size() != byte_length / access_size
      || values->arrayValue.size() > 4096U || !json_text(json_member(*canonical_args, "canonicalTarget"), &args_target) || args_target != canonical_target
      || !json_text(json_member(*target_ref, "kind"), &ref_kind) || !json_text(json_member(*target_ref, "path"), &ref_path)
      || !std::regex_match(ref_path, std::regex("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*"))
      || std::any_of(values->arrayValue.begin(), values->arrayValue.end(), [](const StrictJson& value) { return value.type != StrictJson::Type::number; })) { *reason = "R4 canonical write arguments are invalid"; return false; }
  std::string derived_target;
  if (ref_kind == "scalar") {
    if (!json_exact_keys(*target_ref, {"kind", "path"}) || values->arrayValue.size() != 1U) { *reason = "R4 scalar targetRef is invalid"; return false; }
    derived_target = ref_path;
  } else if (ref_kind == "array_element") {
    uint64_t index = 0;
    if (!json_exact_keys(*target_ref, {"kind", "path", "index"}) || !json_u64(json_member(*target_ref, "index"), &index) || values->arrayValue.size() != 1U) { *reason = "R4 array element targetRef is invalid"; return false; }
    derived_target = ref_path + "[" + std::to_string(index) + "]";
  } else if (ref_kind == "array_slice") {
    uint64_t start = 0;
    if (!json_exact_keys(*target_ref, {"kind", "path", "startIndex"}) || !json_u64(json_member(*target_ref, "startIndex"), &start)
        || start + values->arrayValue.size() - 1U > 9007199254740991ULL) { *reason = "R4 array slice targetRef is invalid"; return false; }
    derived_target = ref_path + "[" + std::to_string(start) + ".." + std::to_string(start + values->arrayValue.size() - 1U) + "]";
  } else { *reason = "R4 targetRef kind is invalid"; return false; }
  if (derived_target != canonical_target || policy_rule != ref_path) { *reason = "R4 write target does not match its policy binding"; return false; }
  if (expected.device != target_id || expected.iface != iface || expected.serial != serial || expected.speedKhz != static_cast<int>(speed)
      || expected.captureId != capture_id || expected.runtimeIdentitySha256 != runtime_sha
      || expected.artifactGeneration != artifact_generation || expected.artifactSha256 != artifact_sha
      || evidence_generation != artifact_generation || expected.address != hex_u32(static_cast<U32>(address))
      || expected.length != static_cast<int>(byte_length) || expected.accessSize != static_cast<int>(access_size) || expected.bytesHex != bytes_hex) {
    *reason = "R4 envelope does not match the helper arguments";
    return false;
  }
  if (!lower_sha256(summary) || !lower_sha256(expected.expectedSummarySha256)) { *reason = "R4 summary SHA-256 is not canonical"; return false; }
  std::string computed_approval_digest;
  if (!r4_compute_approval_digest(root, &computed_approval_digest, reason) || computed_approval_digest != approval_digest) {
    *reason = "R4 approval operation digest is inconsistent";
    return false;
  }
  StrictJson summary_body = root;
  summary_body.objectValue.erase("summarySha256");
  std::string computed_summary;
  if (!sha256_bytes(canonical_json(summary_body), &computed_summary) || computed_summary != summary || computed_summary != expected.expectedSummarySha256) {
    *reason = "R4 envelope summary SHA-256 is inconsistent";
    return false;
  }
  if (expected.enforcePlanPath) {
    std::error_code error;
    const auto plan = std::filesystem::weakly_canonical(std::filesystem::path(expected.planPath), error);
    if (error || lower_path(plan.filename().native()) != L"r4-native-exception.json" || narrow(plan.parent_path().filename().native()) != write_plan_id) {
      *reason = "R4 envelope path does not match its write plan identity";
      return false;
    }
  }
  out->summarySha256 = summary;
  out->writePlanId = write_plan_id;
  out->canonicalTarget = canonical_target;
  out->bytesHex = bytes_hex;
  out->address = static_cast<U32>(address);
  out->byteLength = static_cast<int>(byte_length);
  out->accessSize = static_cast<int>(access_size);
  return true;
}

struct PlanSymbol {
  std::string name;
  U32 address;
  U32 size;
};

struct HssBlockPlan {
  std::vector<JLINK_HSS_MEM_BLOCK_DESC> blocks;
  std::vector<U32> symbolOffsets;
  U32 bytesPerSample = 0;
};

static std::vector<PlanSymbol> json_symbols(const std::string& text) {
  std::vector<PlanSymbol> symbols;
  std::regex pattern("\\{[^{}]*\"name\"\\s*:\\s*\"([^\"]+)\"[^{}]*\"address\"\\s*:\\s*\"0x([0-9a-fA-F]+)\"[^{}]*\"size\"\\s*:\\s*(\\d+)[^{}]*\\}");
  try {
    for (std::sregex_iterator it(text.begin(), text.end(), pattern), end; it != end; ++it) {
      const auto address = std::stoull((*it)[2].str(), nullptr, 16);
      const auto size = std::stoull((*it)[3].str());
      if (address > (std::numeric_limits<U32>::max)() || size > (std::numeric_limits<U32>::max)()) return {};
      symbols.push_back({(*it)[1].str(), static_cast<U32>(address), static_cast<U32>(size)});
    }
  } catch (...) {
    return {};
  }
  return symbols;
}

static bool valid_jcap_symbols(const std::vector<PlanSymbol>& symbols) {
  std::set<std::string> names;
  U32 total_bytes = 0;
  for (const auto& symbol : symbols) {
    std::wstring wide_name;
    if (symbol.name.empty() || symbol.name.size() > 256 || !widen_utf8(symbol.name, &wide_name)
        || !names.insert(symbol.name).second
        || (symbol.size != 1U && symbol.size != 2U && symbol.size != 4U)
        || symbol.address > (std::numeric_limits<U32>::max)() - symbol.size
        || total_bytes > 40U - symbol.size) return false;
    total_bytes += symbol.size;
  }
  return !symbols.empty();
}

static bool capture_sample_budget(int requested_rate, int duration_sec, uint64_t* requested_samples) {
  if (requested_rate < 1 || requested_rate > 16000 || duration_sec < 1 || duration_sec > 60) return false;
  *requested_samples = static_cast<uint64_t>(requested_rate) * static_cast<uint64_t>(duration_sec);
  return *requested_samples > 0 && *requested_samples <= 960000U && *requested_samples <= (std::numeric_limits<U32>::max)();
}

static bool valid_jcap_samples_path(const std::string& output_file, const std::string& capture_id, std::wstring* output_path) {
  std::wstring capture;
  if (!widen_utf8(output_file, output_path) || !widen_utf8(capture_id, &capture)) return false;
  std::replace(output_path->begin(), output_path->end(), L'/', L'\\');
  const bool absolute = (output_path->size() >= 3 && std::iswalpha((*output_path)[0]) && (*output_path)[1] == L':' && (*output_path)[2] == L'\\')
    || (output_path->size() >= 3 && (*output_path)[0] == L'\\' && (*output_path)[1] == L'\\' && (*output_path)[2] != L'?');
  const std::wstring suffix = L"\\" + capture + L".jcap\\raw\\samples.bin";
  if (!absolute || output_path->size() < suffix.size()) return false;
  return std::equal(suffix.rbegin(), suffix.rend(), output_path->rbegin(), [](wchar_t left, wchar_t right) {
    return std::towlower(left) == std::towlower(right);
  });
}

static HssBlockPlan build_hss_block_plan(const std::vector<PlanSymbol>& symbols) {
  struct IndexedSymbol {
    PlanSymbol symbol;
    size_t index;
  };
  std::vector<IndexedSymbol> sorted;
  for (size_t index = 0; index < symbols.size(); ++index) sorted.push_back({symbols[index], index});
  std::sort(sorted.begin(), sorted.end(), [](const IndexedSymbol& left, const IndexedSymbol& right) {
    return left.symbol.address == right.symbol.address ? left.index < right.index : left.symbol.address < right.symbol.address;
  });
  HssBlockPlan plan;
  plan.symbolOffsets.resize(symbols.size());
  for (const auto& item : sorted) {
    if (!plan.blocks.empty() && item.symbol.address == plan.blocks.back().Addr + plan.blocks.back().NumBytes) {
      plan.symbolOffsets[item.index] = plan.bytesPerSample;
      plan.blocks.back().NumBytes += item.symbol.size;
    } else {
      plan.symbolOffsets[item.index] = plan.bytesPerSample;
      plan.blocks.push_back({item.symbol.address, item.symbol.size, 0, 0});
    }
    plan.bytesPerSample += item.symbol.size;
  }
  return plan;
}

static bool hss_buffer_overwritten(const std::vector<unsigned char>& buffer, unsigned char sentinel) {
  return std::any_of(buffer.begin(), buffer.end(), [sentinel](unsigned char byte) { return byte != sentinel; });
}

static bool hss_sample_prefix_overwritten(const std::vector<unsigned char>& buffer, size_t sample_bytes, unsigned char sentinel) {
  const size_t count = (std::min)(buffer.size(), sample_bytes);
  return std::any_of(buffer.begin(), buffer.begin() + count, [sentinel](unsigned char byte) { return byte != sentinel; });
}

static int hss_first_changed_offset(const std::vector<unsigned char>& buffer, unsigned char sentinel) {
  const auto it = std::find_if(buffer.begin(), buffer.end(), [sentinel](unsigned char byte) { return byte != sentinel; });
  return it == buffer.end() ? -1 : static_cast<int>(std::distance(buffer.begin(), it));
}

static std::vector<unsigned char> hss_changed_window(const std::vector<unsigned char>& buffer, int offset) {
  if (offset < 0 || static_cast<size_t>(offset) >= buffer.size()) return {};
  const size_t start = static_cast<size_t>(offset);
  const size_t end = (std::min)(buffer.size(), start + 16U);
  return std::vector<unsigned char>(buffer.begin() + start, buffer.begin() + end);
}

static bool hss_range_overwritten(const std::vector<unsigned char>& buffer, size_t start, size_t length, unsigned char sentinel) {
  if (start >= buffer.size() || length == 0) return false;
  const size_t end = (std::min)(buffer.size(), start + length);
  return std::any_of(buffer.begin() + start, buffer.begin() + end, [sentinel](unsigned char byte) { return byte != sentinel; });
}

static int hss_first_changed_offset_in_range(const std::vector<unsigned char>& buffer, size_t start, size_t length, unsigned char sentinel) {
  if (start >= buffer.size() || length == 0) return -1;
  const size_t end = (std::min)(buffer.size(), start + length);
  const auto it = std::find_if(buffer.begin() + start, buffer.begin() + end, [sentinel](unsigned char byte) { return byte != sentinel; });
  return it == buffer.begin() + end ? -1 : static_cast<int>(std::distance(buffer.begin(), it));
}

static bool hss_capture_failed(bool crashed, uint64_t emitted_samples) {
  return crashed || emitted_samples == 0;
}

enum class HssSampleDecision {
  emit,
  duplicate,
  invalid,
};

struct HssRecordSequence {
  bool hasSample = false;
  bool invalid = false;
  uint32_t firstSampleIndex = 0;
  uint32_t lastSampleIndex = 0;
  uint64_t emittedSamples = 0;
  uint64_t duplicateSamples = 0;
  uint64_t droppedSamples = 0;
};

static HssSampleDecision observe_hss_sample(HssRecordSequence* sequence, uint32_t sample_index, uint32_t* status_flags) {
  *status_flags = 1U;
  if (sequence->hasSample) {
    if (sample_index == sequence->lastSampleIndex) {
      ++sequence->duplicateSamples;
      return HssSampleDecision::duplicate;
    }
    if (sample_index < sequence->lastSampleIndex) {
      sequence->invalid = true;
      return HssSampleDecision::invalid;
    }
    const uint64_t missing = static_cast<uint64_t>(sample_index) - static_cast<uint64_t>(sequence->lastSampleIndex) - 1U;
    if (missing > 0) {
      sequence->droppedSamples += missing;
      *status_flags |= 1U << 4;
    }
  } else {
    sequence->hasSample = true;
    sequence->firstSampleIndex = sample_index;
  }
  sequence->lastSampleIndex = sample_index;
  ++sequence->emittedSamples;
  return HssSampleDecision::emit;
}

enum class PostConnectDecision {
  pending,
  stable,
  recoveryRestart,
  nonWrappingDecrease,
};

struct PostConnectStabilityEvidence {
  bool passed = false;
  bool hasValue = false;
  bool hasRate = false;
  bool runningWindowObserved = false;
  int checkCount = 0;
  int consecutiveRunningChecks = 0;
  int64_t elapsedMs = 0;
  U32 firstValue = 0;
  U32 lastValue = 0;
  double firstRateHz = 0.0;
  double lastRateHz = 0.0;
  double minRateHz = 0.0;
  double maxRateHz = 0.0;
};

static PostConnectDecision observe_post_connect_counter(
    PostConnectStabilityEvidence* evidence,
    U32 value,
    int64_t interval_ns,
    int64_t elapsed_ms,
    int minimum_recovery_ms,
    int required_consecutive_checks,
    double min_rate_hz,
    double max_rate_hz) {
  if (!evidence->hasValue) {
    evidence->hasValue = true;
    evidence->firstValue = value;
    evidence->lastValue = value;
    return PostConnectDecision::pending;
  }
  const U32 previous = evidence->lastValue;
  const U32 delta = value - previous;
  const double rate_hz = interval_ns > 0 ? static_cast<double>(delta) * 1000000000.0 / static_cast<double>(interval_ns) : 0.0;
  evidence->lastValue = value;
  evidence->lastRateHz = rate_hz;
  if (!evidence->hasRate) {
    evidence->hasRate = true;
    evidence->firstRateHz = rate_hz;
    evidence->minRateHz = rate_hz;
    evidence->maxRateHz = rate_hz;
  } else {
    evidence->minRateHz = (std::min)(evidence->minRateHz, rate_hz);
    evidence->maxRateHz = (std::max)(evidence->maxRateHz, rate_hz);
  }
  const bool rate_valid = delta > 0 && rate_hz >= min_rate_hz && rate_hz <= max_rate_hz;
  if (value < previous && !rate_valid) {
    if (elapsed_ms < minimum_recovery_ms && !evidence->runningWindowObserved) return PostConnectDecision::recoveryRestart;
    return PostConnectDecision::nonWrappingDecrease;
  }
  if (rate_valid) evidence->runningWindowObserved = true;
  evidence->consecutiveRunningChecks = rate_valid ? evidence->consecutiveRunningChecks + 1 : 0;
  return elapsed_ms >= minimum_recovery_ms && evidence->consecutiveRunningChecks >= required_consecutive_checks
    ? PostConnectDecision::stable
    : PostConnectDecision::pending;
}

static void write_post_connect_evidence(const PostConnectStabilityEvidence& evidence) {
  std::cout
    << ",\"postConnectStability\":{\"passed\":" << (evidence.passed ? "true" : "false")
    << ",\"checkCount\":" << evidence.checkCount
    << ",\"runningWindowObserved\":" << (evidence.runningWindowObserved ? "true" : "false")
    << ",\"consecutiveRunningChecks\":" << evidence.consecutiveRunningChecks
    << ",\"elapsedMs\":" << evidence.elapsedMs
    << ",\"firstValue\":" << evidence.firstValue
    << ",\"lastValue\":" << evidence.lastValue
    << ",\"firstRateHz\":" << evidence.firstRateHz
    << ",\"lastRateHz\":" << evidence.lastRateHz
    << ",\"minRateHz\":" << evidence.minRateHz
    << ",\"maxRateHz\":" << evidence.maxRateHz << "}";
}

static bool wait_for_post_connect_stability(
    JLINKARM_IsHalted_Fn arm_halted,
    JLINKARM_ReadMemU32_Fn arm_read_u32,
    U32 counter_address,
    int expected_rate_hz,
    double rate_tolerance_ratio,
    int minimum_recovery_ms,
    int timeout_ms,
    int poll_interval_ms,
    int required_consecutive_checks,
    PostConnectStabilityEvidence* evidence,
    std::string* error_code,
    std::string* reason) {
  const double min_rate_hz = static_cast<double>(expected_rate_hz) * (1.0 - rate_tolerance_ratio);
  const double max_rate_hz = static_cast<double>(expected_rate_hz) * (1.0 + rate_tolerance_ratio);
  const int64_t started_ns = now_ns();
  int64_t previous_read_ns = started_ns;
  while (true) {
    const int64_t read_ns = now_ns();
    evidence->elapsedMs = (read_ns - started_ns) / 1000000;
    if (evidence->elapsedMs > timeout_ms) {
      *error_code = "HSS_POST_CONNECT_STABILITY_TIMEOUT";
      *reason = "post-connect counter did not reach the bounded running-rate stability gate";
      return false;
    }
    bool crashed = false;
    const int halted = call_int0(arm_halted, &crashed);
    ++evidence->checkCount;
    if (crashed || halted < 0) {
      *error_code = "HSS_POST_CONNECT_TARGET_STATE_READ_FAILED";
      *reason = "post-connect target-state read failed";
      return false;
    }
    if (halted > 0) {
      *error_code = "HSS_POST_CONNECT_TARGET_HALTED";
      *reason = "target halted during post-connect stability gate";
      return false;
    }
    U32 value = 0;
    U8 read_status = 0xFFU;
    const int read_rc = call_read_mem_u32(arm_read_u32, counter_address, 1U, &value, &read_status, &crashed);
    if (crashed || read_rc < 0 || read_status != 0U) {
      *error_code = "HSS_POST_CONNECT_COUNTER_READ_FAILED";
      *reason = "post-connect counter read failed";
      return false;
    }
    const PostConnectDecision decision = observe_post_connect_counter(
      evidence,
      value,
      read_ns - previous_read_ns,
      evidence->elapsedMs,
      minimum_recovery_ms,
      required_consecutive_checks,
      min_rate_hz,
      max_rate_hz);
    previous_read_ns = read_ns;
    if (decision == PostConnectDecision::nonWrappingDecrease) {
      *error_code = "HSS_POST_CONNECT_COUNTER_DECREASE";
      *reason = "post-connect counter decreased without a rate-valid uint32 wrap";
      return false;
    }
    if (decision == PostConnectDecision::stable) {
      evidence->passed = true;
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(poll_interval_ms));
  }
}

enum class JcapAppendResult { appended, budgetExhausted, failed };

class JcapSampleWriter {
 public:
  static constexpr uint64_t kByteBudget = 512ULL * 1024ULL * 1024ULL;

  explicit JcapSampleWriter(uint64_t byte_budget = kByteBudget) : byte_budget_(byte_budget) {}

  ~JcapSampleWriter() { close(); }

  bool open(const std::wstring& path) {
    handle_ = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    return handle_ != INVALID_HANDLE_VALUE;
  }

  JcapAppendResult append(
      uint32_t sample_index,
      uint64_t tick,
      uint32_t status_flags,
      const std::vector<PlanSymbol>& symbols,
      const std::vector<uint32_t>& values,
      std::string* frame_for_test = nullptr) {
    if (handle_ == INVALID_HANDLE_VALUE || symbols.size() != values.size()) return JcapAppendResult::failed;
    std::ostringstream payload;
    payload << "{\"sampleIndex\":" << sample_index << ",\"tick\":\"" << tick << "\",\"statusFlags\":" << status_flags << ",\"values\":{";
    for (size_t index = 0; index < symbols.size(); ++index) {
      if (index > 0) payload << ',';
      payload << '"' << escape(symbols[index].name) << "\":" << values[index];
    }
    payload << "}}";
    const std::string payload_bytes = payload.str();
    std::string payload_sha256;
    if (!sha256_bytes(payload_bytes, &payload_sha256)) return JcapAppendResult::failed;
    std::ostringstream header;
    header << "{\"formatVersion\":0,\"status\":\"experimental\",\"kind\":\"sample\",\"payloadEncoding\":\"json\",\"payloadBytes\":"
           << payload_bytes.size() << ",\"payloadSha256\":\"" << payload_sha256 << "\"}\n";
    const std::string frame = header.str() + payload_bytes + '\n';
    if (bytes_ + frame.size() > byte_budget_) return JcapAppendResult::budgetExhausted;
    if (!write_all(frame)) return JcapAppendResult::failed;
    bytes_ += frame.size();
    if (frame_for_test) *frame_for_test = frame;
    return JcapAppendResult::appended;
  }

  bool finalize() {
    if (handle_ == INVALID_HANDLE_VALUE) return finalized_;
    const bool flushed = FlushFileBuffers(handle_) != FALSE;
    const bool closed = CloseHandle(handle_) != FALSE;
    handle_ = INVALID_HANDLE_VALUE;
    finalized_ = flushed && closed;
    return finalized_;
  }

  uint64_t bytes() const { return bytes_; }

 private:
  bool write_all(const std::string& bytes) {
    size_t offset = 0;
    while (offset < bytes.size()) {
      const DWORD chunk = static_cast<DWORD>((std::min)(bytes.size() - offset, static_cast<size_t>((std::numeric_limits<DWORD>::max)())));
      DWORD written = 0;
      if (!WriteFile(handle_, bytes.data() + offset, chunk, &written, nullptr) || written == 0) return false;
      offset += written;
    }
    return true;
  }

  void close() {
    if (handle_ == INVALID_HANDLE_VALUE) return;
    (void)FlushFileBuffers(handle_);
    (void)CloseHandle(handle_);
    handle_ = INVALID_HANDLE_VALUE;
  }

  HANDLE handle_ = INVALID_HANDLE_VALUE;
  uint64_t byte_budget_ = kByteBudget;
  uint64_t bytes_ = 0;
  bool finalized_ = false;
};

static void stream_lifecycle(const std::string& capture_id, const char* phase, int64_t counter, const std::string& details = "") {
  std::cout << "{\"record\":\"lifecycle\",\"phase\":\"" << phase << "\",\"captureId\":\"" << escape(capture_id)
            << "\"";
  if (counter >= 0) std::cout << ",\"qpcCounter\":\"" << counter << "\"";
  else std::cout << ",\"qpcUnavailable\":true";
  std::cout << details << "}\n" << std::flush;
}

static void stream_fault(const std::string& capture_id, const std::string& code, const std::string& reason, int64_t counter) {
  std::cout << "{\"record\":\"fault\",\"captureId\":\"" << escape(capture_id)
            << "\"";
  if (counter >= 0) std::cout << ",\"qpcCounter\":\"" << counter << "\"";
  else std::cout << ",\"qpcUnavailable\":true";
  std::cout << ",\"errorCode\":\"" << escape(code) << "\",\"reason\":\"" << escape(reason) << "\"}\n" << std::flush;
}

static std::string hex_bytes(const std::string& bytes) {
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (unsigned char byte : bytes) out << std::setw(2) << static_cast<unsigned>(byte);
  return out.str();
}

static void required_base_json(bool open, bool close, bool exec, bool tif, bool speed, bool connect) {
  std::cout
    << "\"baseExports\":{\"JLINKARM_Open\":" << (open ? "true" : "false")
    << ",\"JLINKARM_Close\":" << (close ? "true" : "false")
    << ",\"JLINKARM_ExecCommand\":" << (exec ? "true" : "false")
    << ",\"JLINKARM_TIF_Select\":" << (tif ? "true" : "false")
    << ",\"JLINKARM_SetSpeed\":" << (speed ? "true" : "false")
    << ",\"JLINKARM_Connect\":" << (connect ? "true" : "false")
    << "}";
}

static int preflight(const std::wstring& dll_path) {
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  const std::string dll_utf8 = narrow(dll_path);
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }
  const bool getcaps = required(dll, "JLINK_HSS_GetCaps") != nullptr;
  const bool start = required(dll, "JLINK_HSS_Start") != nullptr;
  const bool read = required(dll, "JLINK_HSS_Read") != nullptr;
  const bool stop = required(dll, "JLINK_HSS_Stop") != nullptr;
  const bool arm_open = required(dll, "JLINKARM_Open") != nullptr;
  const bool arm_close = required(dll, "JLINKARM_Close") != nullptr;
  const bool arm_exec = required(dll, "JLINKARM_ExecCommand") != nullptr;
  const bool arm_tif = required(dll, "JLINKARM_TIF_Select") != nullptr;
  const bool arm_speed = required(dll, "JLINKARM_SetSpeed") != nullptr;
  const bool arm_connect = required(dll, "JLINKARM_Connect") != nullptr;
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  bool version_crashed = false;
  const int dll_version = arm_version ? call_int0(arm_version, &version_crashed) : 0;
  std::cout
    << "{\"status\":\"ok\",\"dll\":\"" << escape(dll_utf8)
    << "\",\"exports\":{\"JLINK_HSS_GetCaps\":" << (getcaps ? "true" : "false")
    << ",\"JLINK_HSS_Start\":" << (start ? "true" : "false")
    << ",\"JLINK_HSS_Read\":" << (read ? "true" : "false")
    << ",\"JLINK_HSS_Stop\":" << (stop ? "true" : "false")
    << "},\"exportsFound\":" << (getcaps && start && read && stop ? "true" : "false")
    << ",\"dllVersion\":" << (!version_crashed ? dll_version : 0)
    << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
    << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",";
  required_base_json(arm_open, arm_close, arm_exec, arm_tif, arm_speed, arm_connect);
  std::cout
    << ",\"baseApiCandidate\":\"AUTHORIZED_UNVERIFIED_BASE_API_CANDIDATE\""
    << ",\"candidateApi\":\"HSS_PUBLIC_PROTOTYPE_CANDIDATE_USED_FOR_EXPERIMENT\"}";
  FreeLibrary(dll);
  return 0;
}

static std::string option_utf8(const std::map<std::wstring, std::wstring>& options, const wchar_t* name, const char* fallback);

struct JlinkScriptSelection {
  std::string mode;
  bool enabled = false;
  HANDLE handle = INVALID_HANDLE_VALUE;
  std::wstring path;
  std::string pathUtf8;
  std::string sha256;
  ~JlinkScriptSelection() { if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle); }
  JlinkScriptSelection() = default;
  JlinkScriptSelection(const JlinkScriptSelection&) = delete;
  JlinkScriptSelection& operator=(const JlinkScriptSelection&) = delete;
};

static bool is_absolute_windows_path(const std::wstring& path) {
  return (path.size() >= 3 && std::iswalpha(path[0]) != 0 && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/'))
    || (path.size() >= 2 && path[0] == L'\\' && path[1] == L'\\');
}

static std::wstring canonical_windows_path(const std::wstring& path) {
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetFullPathNameW(path.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (length == 0 || length >= buffer.size()) return L"";
  return std::wstring(buffer.data(), length);
}

static bool path_contains_reparse_point(const std::wstring& path) {
  for (size_t index = 3; index <= path.size(); ++index) {
    if (index != path.size() && path[index] != L'\\') continue;
    const std::wstring component = path.substr(0, index);
    const DWORD attributes = GetFileAttributesW(component.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return true;
  }
  return false;
}

static bool prepare_jlink_script(
    const std::string& mode,
    const std::wstring& path,
    const std::string& approved_sha256,
    JlinkScriptSelection* selection,
    std::string* error_code,
    std::string* reason) {
  if (mode != "none" && mode != "file") {
    *error_code = "HSS_JLINK_SCRIPT_MODE_INVALID";
    *reason = "--jlink-script-mode must be explicitly set to none or file";
    return false;
  }
  if (mode == "none") {
    if (!path.empty() || !approved_sha256.empty()) {
      *error_code = "HSS_JLINK_SCRIPT_ARGUMENTS_INVALID";
      *reason = "J-Link script path and SHA-256 are forbidden when script mode is none";
      return false;
    }
    selection->mode = mode;
    return true;
  }
  if (path.empty() || !valid_sha256_hex(approved_sha256)) {
    *error_code = "HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED";
    *reason = "J-Link script selection requires an absolute path and approved SHA-256";
    return false;
  }
  if (!is_absolute_windows_path(path) || path.find(L'\r') != std::wstring::npos || path.find(L'\n') != std::wstring::npos) {
    *error_code = "HSS_JLINK_SCRIPT_PATH_INVALID";
    *reason = "J-Link script path must be an absolute Windows path without control characters";
    return false;
  }
  const std::wstring canonical = canonical_windows_path(path);
  if (canonical.empty() || _wcsicmp(canonical.c_str(), path.c_str()) != 0 || path_contains_reparse_point(canonical)) {
    *error_code = "HSS_JLINK_SCRIPT_PATH_INVALID";
    *reason = "J-Link script path must be canonical and contain no reparse points";
    return false;
  }
  const DWORD attributes = GetFileAttributesW(canonical.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    *error_code = "HSS_JLINK_SCRIPT_MISSING";
    *reason = "approved J-Link script file does not exist";
    return false;
  }
  HANDLE handle = CreateFileW(canonical.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK
      || !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag))
      || (tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    *error_code = "HSS_JLINK_SCRIPT_PATH_INVALID";
    *reason = "J-Link script must be a regular non-reparse file";
    return false;
  }
  std::string actual_sha256;
  if (!sha256_handle(handle, &actual_sha256)) {
    CloseHandle(handle);
    *error_code = "HSS_JLINK_SCRIPT_HASH_FAILED";
    *reason = "approved J-Link script file could not be hashed";
    return false;
  }
  std::string normalized_approved_sha256 = approved_sha256;
  std::transform(normalized_approved_sha256.begin(), normalized_approved_sha256.end(), normalized_approved_sha256.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (actual_sha256 != normalized_approved_sha256) {
    CloseHandle(handle);
    *error_code = "HSS_JLINK_SCRIPT_IDENTITY_CHANGED";
    *reason = "J-Link script SHA-256 does not match the approved identity";
    return false;
  }
  selection->mode = mode;
  selection->enabled = true;
  selection->handle = handle;
  selection->path = canonical;
  selection->pathUtf8 = narrow(canonical);
  if (selection->pathUtf8.empty()) {
    *error_code = "HSS_JLINK_SCRIPT_PATH_INVALID";
    *reason = "J-Link script path is not lossless UTF-8";
    return false;
  }
  selection->sha256 = actual_sha256;
  return true;
}

static bool apply_jlink_script(
    JLINKARM_ExecCommand_Fn arm_exec,
    const JlinkScriptSelection& selection,
    int* return_code,
    char* output,
    int output_size,
    bool* crashed) {
  if (selection.mode == "none") {
    *return_code = 0;
    *crashed = false;
    if (output_size > 0) output[0] = '\0';
    return true;
  }
  if (!selection.enabled || selection.handle == INVALID_HANDLE_VALUE) return false;
  const std::string command = "ScriptFile = " + selection.pathUtf8;
  *return_code = call_exec(arm_exec, command.c_str(), output, output_size, crashed);
  if (*crashed || *return_code != 0) return false;
  std::string actual_sha256;
  return sha256_handle(selection.handle, &actual_sha256) && actual_sha256 == selection.sha256;
}

static int getcaps(const std::wstring& dll_path, const std::map<std::wstring, std::wstring>& options) {
  const std::string dll_utf8 = narrow(dll_path);
  const std::string device = option_utf8(options, L"--device", "");
  if (device.empty()) {
    error_json("HSS_GETCAPS_DEVICE_REQUIRED", "--device is required before JLINK_HSS_GetCaps candidate call", dll_utf8);
    return 0;
  }
  const auto script_it = options.find(L"--jlink-script-file");
  const std::wstring script_path = script_it == options.end() ? L"" : script_it->second;
  JlinkScriptSelection script_selection;
  std::string script_error_code;
  std::string script_error_reason;
  if (!prepare_jlink_script(
      option_utf8(options, L"--jlink-script-mode", ""),
      script_path,
      option_utf8(options, L"--approved-jlink-script-sha256", ""),
      &script_selection,
      &script_error_code,
      &script_error_reason)) {
    error_json(script_error_code, script_error_reason, dll_utf8);
    return 0;
  }
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }
  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  auto fn = reinterpret_cast<JLINK_HSS_GetCaps_Fn>(required(dll, "JLINK_HSS_GetCaps"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !arm_version || !fn) {
    FreeLibrary(dll);
    error_json("HSS_EXPORT_MISSING", "required JLINKARM/JLINK_HSS_GetCaps exports missing", dll_utf8);
    return 0;
  }

  const std::string iface = option_utf8(options, L"--interface", "SWD");
  const std::string serial_text = option_utf8(options, L"--serial", "");
  const int speed = std::stoi(option_utf8(options, L"--speed", "4000"));
  const int tif = iface == "JTAG" ? 0 : 1;
  JLINK_HSS_CAPS caps{};
  bool crashed = false;
  const int dll_version = call_int0(arm_version, &crashed);
  if (crashed || dll_version <= 0) {
    FreeLibrary(dll);
    error_json("HSS_DLL_VERSION_INVALID", "JLINKARM_GetDLLVersion failed", dll_utf8);
    return 0;
  }
  if (!serial_text.empty() && arm_select_sn) {
    (void)call_select_sn(arm_select_sn, static_cast<U32>(std::stoul(serial_text)), &crashed);
    if (crashed) {
      FreeLibrary(dll);
      error_json("JLINK_SELECT_SN_EXCEPTION", "JLINKARM_EMU_SelectByUSBSN raised a structured exception", dll_utf8);
      return 0;
    }
  }
  int open_rc = call_int0(arm_open, &crashed);
  if (crashed || open_rc < 0) {
    FreeLibrary(dll);
    error_json("JLINK_OPEN_FAILED", "JLINKARM_Open failed", dll_utf8);
    return 0;
  }
  if (!suppress_jlink_gui(arm_exec, &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_SUPPRESS_GUI_EXCEPTION", "JLINKARM_ExecCommand(SuppressGUI) raised a structured exception", dll_utf8);
    return 0;
  }
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  (void)call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_EXEC_DEVICE_EXCEPTION", "JLINKARM_ExecCommand(device) raised a structured exception", dll_utf8);
    return 0;
  }
  char script_exec_out[512] = {};
  int script_rc = 0;
  if (!apply_jlink_script(arm_exec, script_selection, &script_rc, script_exec_out, sizeof(script_exec_out), &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json(crashed || script_rc != 0 ? "JLINK_SCRIPT_SELECT_FAILED" : "HSS_JLINK_SCRIPT_IDENTITY_CHANGED", "approved J-Link script selection failed or changed before target connect", dll_utf8);
    return 0;
  }
  (void)call_int1(arm_tif, tif, &crashed);
  call_void1(arm_speed, speed, &crashed);
  int connect_rc = call_int0(arm_connect, &crashed);
  if (crashed || connect_rc < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_CONNECT_FAILED", "JLINKARM_Connect failed", dll_utf8);
    return 0;
  }

  int return_code = call_getcaps(fn, &caps, &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("HSS_GETCAPS_EXCEPTION", "JLINK_HSS_GetCaps raised a structured exception", dll_utf8);
    return 0;
  }
  call_void0(arm_close, &crashed);
  if (return_code < 0 || caps.MaxBlocks == 0 || caps.MaxFreq == 0) {
    std::cout
      << "{\"status\":\"error\",\"errorCode\":\"" << (return_code < 0 ? "HSS_GETCAPS_FAILED" : "HSS_GETCAPS_INVALID")
      << "\",\"reason\":\"JLINK_HSS_GetCaps returned an error or invalid capabilities\""
      << ",\"returnCode\":" << return_code
      << ",\"dllVersion\":" << dll_version
      << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
      << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION << "}";
    FreeLibrary(dll);
    return 0;
  }
  std::cout
    << "{\"status\":\"ok\",\"api\":\"JLINK_HSS_GetCaps\",\"dll\":\"" << escape(dll_utf8)
    << "\",\"dllVersion\":" << dll_version << ",\"returnCode\":" << return_code
    << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
    << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",\"device\":\"" << escape(device)
    << "\",\"interface\":\"" << escape(iface)
    << "\",\"speedKhz\":" << speed
    << ",\"connectReturnCode\":" << connect_rc
    << ",\"execOutput\":\"" << escape(exec_out) << "\""
    << ",\"jlinkScriptMode\":\"" << script_selection.mode << "\""
    << ",\"jlinkScriptFile\":\"" << escape(script_selection.pathUtf8) << "\""
    << ",\"jlinkScriptSha256\":\"" << escape(script_selection.sha256) << "\""
    << ",\"jlinkScriptReturnCode\":" << script_rc
    << ",\"jlinkScriptExecOutput\":\"" << escape(script_exec_out) << "\""
    << ",\"caps\":{\"maxBlocks\":" << caps.MaxBlocks
    << ",\"maxFreq\":" << caps.MaxFreq
    << ",\"caps\":" << caps.Caps
    << ",\"raw\":[" << caps.MaxBlocks << "," << caps.MaxFreq << "," << caps.Caps;
  for (U32 value : caps.aDummy) std::cout << "," << value;
  std::cout << "]},\"error\":null}";
  FreeLibrary(dll);
  return 0;
}

static std::string option_utf8(const std::map<std::wstring, std::wstring>& options, const wchar_t* name, const char* fallback = "") {
  const auto it = options.find(name);
  return it == options.end() ? std::string(fallback) : narrow(it->second);
}

static bool parse_u32_text(const std::string& text, U32* value) {
  try {
    size_t consumed = 0;
    const unsigned long long parsed = std::stoull(text, &consumed, 0);
    if (consumed != text.size() || parsed > 0xFFFFFFFFULL) return false;
    *value = static_cast<U32>(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

static bool parse_int_text(const std::string& text, int* value) {
  try {
    size_t consumed = 0;
    const int parsed = std::stoi(text, &consumed, 10);
    if (consumed != text.size()) return false;
    *value = parsed;
    return true;
  } catch (...) {
    return false;
  }
}

static std::string hex_u32(U32 value) {
  std::ostringstream out;
  out << "0x" << std::hex << std::nouppercase << value;
  return out.str();
}

static std::string bytes_hex(const std::vector<unsigned char>& bytes) {
  std::ostringstream out;
  out << std::hex << std::nouppercase << std::setfill('0');
  for (unsigned char byte : bytes) out << std::setw(2) << static_cast<unsigned int>(byte);
  return out.str();
}

static std::string read_text_file_a(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return "";
  std::ostringstream out;
  out << file.rdbuf();
  return out.str();
}

static bool parse_hex_bytes(const std::string& text, std::vector<unsigned char>* bytes) {
  if ((text.size() % 2U) != 0U) return false;
  bytes->clear();
  bytes->reserve(text.size() / 2U);
  for (size_t index = 0; index < text.size(); index += 2U) {
    const unsigned char hi = static_cast<unsigned char>(text[index]);
    const unsigned char lo = static_cast<unsigned char>(text[index + 1U]);
    if (!std::isxdigit(hi) || !std::isxdigit(lo)) return false;
    bytes->push_back(static_cast<unsigned char>(std::stoul(text.substr(index, 2U), nullptr, 16)));
  }
  return true;
}

struct ArtifactMatchRange {
  U32 address = 0;
  std::vector<unsigned char> expected;
};

struct ArtifactMatchManifest {
  std::string captureId;
  std::string targetId;
  std::string probeSerial;
  std::string runtimeIdentitySha256;
  std::string artifactGeneration;
  std::string artifactSha256;
  uint64_t connectOrdinal = 0;
  uint64_t totalBytes = 0;
  std::vector<ArtifactMatchRange> ranges;
};

enum class ArtifactMatchStatus { verified, mismatch, unverified };

struct ArtifactMatchResult {
  ArtifactMatchStatus status = ArtifactMatchStatus::unverified;
  uint64_t bytesCompared = 0;
  uint64_t transientMismatches = 0;
  U32 address = 0;
  std::string reason;
  std::string gateErrorCode;
};

static bool artifact_match_capture_allowed(const ArtifactMatchResult& result) {
  return result.gateErrorCode.empty();
}

static bool artifact_match_write_allowed(const ArtifactMatchResult& result) {
  return artifact_match_capture_allowed(result) && result.status == ArtifactMatchStatus::verified;
}

class ArtifactMatchConnectionState {
 public:
  uint64_t connected() {
    verified_ = false;
    return ++connectOrdinal_;
  }

  bool recordVerified(uint64_t connect_ordinal) {
    verified_ = connect_ordinal == connectOrdinal_;
    return verified_;
  }

  bool consumeVerified(uint64_t connect_ordinal) {
    if (!verified_ || connect_ordinal != connectOrdinal_) return false;
    verified_ = false;
    return true;
  }

  uint64_t connectOrdinal() const { return connectOrdinal_; }

 private:
  uint64_t connectOrdinal_ = 0;
  bool verified_ = false;
};

using ArtifactReadChunk = std::function<bool(U32, U32, U8*, std::string*)>;

static bool parse_manifest_ranges(const std::string& text, ArtifactMatchManifest* manifest, std::string* reason) {
  constexpr size_t kPrefixBytes = sizeof("{\"address\":\"0x") - 1U;
  constexpr size_t kLengthBytes = sizeof("\",\"length\":") - 1U;
  constexpr size_t kDataBytes = sizeof(",\"dataHex\":\"") - 1U;
  const size_t ranges_key = text.find("\"ranges\":[");
  if (ranges_key == std::string::npos) {
    *reason = "manifest ranges are missing";
    return false;
  }
  size_t position = ranges_key + sizeof("\"ranges\":[") - 1U;
  uint64_t total = 0;
  while (position < text.size()) {
    if (text[position] == ']') {
      ++position;
      break;
    }
    if (!manifest->ranges.empty()) {
      if (text[position] != ',') {
        *reason = "manifest range separator is invalid";
        return false;
      }
      ++position;
    }
    if (text.compare(position, kPrefixBytes, "{\"address\":\"0x") != 0) {
      *reason = "manifest range address is malformed";
      return false;
    }
    position += kPrefixBytes;
    const size_t address_end = text.find("\",\"length\":", position);
    if (address_end == std::string::npos) {
      *reason = "manifest range length is missing";
      return false;
    }
    U32 address = 0;
    if (!parse_u32_text("0x" + text.substr(position, address_end - position), &address)) {
      *reason = "manifest range address is outside uint32";
      return false;
    }
    position = address_end + kLengthBytes;
    const size_t length_end = text.find(",\"dataHex\":\"", position);
    if (length_end == std::string::npos) {
      *reason = "manifest range data is missing";
      return false;
    }
    uint64_t length = 0;
    try {
      size_t consumed = 0;
      length = std::stoull(text.substr(position, length_end - position), &consumed, 10);
      if (consumed != length_end - position) throw std::runtime_error("invalid length");
    } catch (...) {
      *reason = "manifest range length is invalid";
      return false;
    }
    position = length_end + kDataBytes;
    const size_t data_end = text.find("\"}", position);
    if (data_end == std::string::npos || length == 0 || length > 64U * 1024U * 1024U
        || address + length > 0x1'0000'0000ULL) {
      *reason = "manifest range bounds are invalid";
      return false;
    }
    std::vector<unsigned char> expected;
    if (data_end - position != length * 2U || !parse_hex_bytes(text.substr(position, data_end - position), &expected)) {
      *reason = "manifest range dataHex does not match its length";
      return false;
    }
    total += length;
    if (manifest->ranges.size() >= 4096U || total > 64U * 1024U * 1024U) {
      *reason = "manifest exceeds its range or byte bound";
      return false;
    }
    manifest->ranges.push_back({address, std::move(expected)});
    position = data_end + 2U;
  }
  if (manifest->ranges.empty() || position > text.size() || total != manifest->totalBytes) {
    *reason = "manifest totalBytes does not match its nonvolatile ranges";
    return false;
  }
  std::sort(manifest->ranges.begin(), manifest->ranges.end(), [](const ArtifactMatchRange& left, const ArtifactMatchRange& right) {
    return left.address < right.address;
  });
  for (size_t index = 1; index < manifest->ranges.size(); ++index) {
    const auto& previous = manifest->ranges[index - 1U];
    if (manifest->ranges[index].address < static_cast<uint64_t>(previous.address) + previous.expected.size()) {
      *reason = "manifest ranges overlap";
      return false;
    }
  }
  return true;
}

static bool parse_artifact_match_manifest(const std::string& text, ArtifactMatchManifest* manifest, std::string* reason) {
  if (json_string(text, "schema") != "artifact-match-v0" || json_bool(text, "historyOnly", true)) {
    *reason = "manifest schema or historyOnly boundary is invalid";
    return false;
  }
  manifest->captureId = json_string(text, "captureId");
  manifest->targetId = json_string(text, "targetId");
  manifest->probeSerial = json_string(text, "probeSerial");
  manifest->runtimeIdentitySha256 = json_string(text, "runtimeIdentitySha256");
  manifest->artifactGeneration = json_string(text, "artifactGeneration");
  manifest->artifactSha256 = json_string(text, "artifactSha256");
  const int connect_ordinal = json_int(text, "connectOrdinal", -1);
  const int total_bytes = json_int(text, "totalBytes", -1);
  if (manifest->captureId.empty() || manifest->targetId.empty() || manifest->probeSerial.empty()
      || !valid_sha256_hex(manifest->runtimeIdentitySha256) || !valid_sha256_hex(manifest->artifactGeneration)
      || !valid_sha256_hex(manifest->artifactSha256) || connect_ordinal < 1 || total_bytes < 1) {
    *reason = "manifest bindings are missing or invalid";
    return false;
  }
  manifest->connectOrdinal = static_cast<uint64_t>(connect_ordinal);
  manifest->totalBytes = static_cast<uint64_t>(total_bytes);
  return parse_manifest_ranges(text, manifest, reason);
}

static bool read_bounded_text_file(const std::wstring& path, size_t maximum_bytes, std::string* bytes) {
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  if (!file) return false;
  const std::streamoff size = file.tellg();
  if (size <= 0 || static_cast<uint64_t>(size) > maximum_bytes) return false;
  bytes->assign(static_cast<size_t>(size), '\0');
  file.seekg(0);
  return static_cast<bool>(file.read(bytes->data(), size));
}

static std::wstring lower_path(std::wstring path) {
  std::transform(path.begin(), path.end(), path.begin(), [](wchar_t ch) { return std::towlower(ch); });
  return path;
}

static bool manifest_is_in_plan_session(const std::wstring& manifest_path, const std::wstring& plan_path) {
  std::error_code error;
  const auto manifest = std::filesystem::weakly_canonical(manifest_path, error);
  if (error) return false;
  const auto plan = std::filesystem::weakly_canonical(plan_path, error);
  return !error && lower_path(manifest.parent_path().native()) == lower_path(plan.parent_path().native())
    && lower_path(manifest.filename().native()) == L"artifact-match-v0.json";
}

static bool load_artifact_match_manifest(
    const std::wstring& manifest_path,
    const std::wstring& plan_path,
    const std::string& expected_manifest_sha256,
    const std::string& capture_id,
    const std::string& target_id,
    const std::string& probe_serial,
    const std::string& runtime_identity_sha256,
    const std::string& artifact_generation,
    const std::string& artifact_sha256,
    ArtifactMatchManifest* manifest,
    std::string* error_code,
    std::string* reason) {
  if (!manifest_is_in_plan_session(manifest_path, plan_path)) {
    *error_code = "ARTIFACT_MATCH_MANIFEST_PATH_INVALID";
    *reason = "artifact match manifest must be artifact-match-v0.json in the helper plan session";
    return false;
  }
  std::string bytes;
  if (!read_bounded_text_file(manifest_path, 129U * 1024U * 1024U, &bytes)) {
    *error_code = "ARTIFACT_MATCH_MANIFEST_READ_FAILED";
    *reason = "artifact match manifest is missing, empty, or exceeds its byte bound";
    return false;
  }
  std::string actual_sha256;
  std::string normalized_expected = expected_manifest_sha256;
  std::transform(normalized_expected.begin(), normalized_expected.end(), normalized_expected.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (!valid_sha256_hex(normalized_expected) || !sha256_bytes(bytes, &actual_sha256) || actual_sha256 != normalized_expected) {
    *error_code = "ARTIFACT_MATCH_MANIFEST_HASH_MISMATCH";
    *reason = "artifact match manifest SHA-256 does not match the capture plan";
    return false;
  }
  if (!parse_artifact_match_manifest(bytes, manifest, reason)) {
    *error_code = "ARTIFACT_MATCH_MANIFEST_INVALID";
    return false;
  }
  if (manifest->captureId != capture_id || manifest->targetId != target_id || manifest->probeSerial != probe_serial
      || manifest->runtimeIdentitySha256 != runtime_identity_sha256 || manifest->artifactGeneration != artifact_generation
      || manifest->artifactSha256 != artifact_sha256) {
    *error_code = "ARTIFACT_MATCH_BINDING_MISMATCH";
    *reason = "artifact match manifest bindings do not match the capture plan";
    return false;
  }
  return true;
}

static ArtifactMatchResult compare_artifact_ranges(const ArtifactMatchManifest& manifest, const ArtifactReadChunk& read_chunk) {
  ArtifactMatchResult result;
  constexpr U32 kChunkBytes = 256U;
  for (const auto& range : manifest.ranges) {
    for (size_t offset = 0; offset < range.expected.size(); offset += kChunkBytes) {
      const U32 count = static_cast<U32>((std::min)(static_cast<size_t>(kChunkBytes), range.expected.size() - offset));
      std::vector<U8> actual(count);
      std::string reason;
      const U32 address = range.address + static_cast<U32>(offset);
      if (!read_chunk(address, count, actual.data(), &reason)) {
        result.address = address;
        result.reason = reason.empty() ? "target returned an incomplete or failed nonvolatile read" : reason;
        result.gateErrorCode = "ARTIFACT_MATCH_READ_INCOMPLETE";
        return result;
      }
      for (U32 index = 0; index < count; ++index) {
        ++result.bytesCompared;
        if (actual[index] != range.expected[offset + index]) {
          bool confirmedExpected = true;
          for (int confirmation = 0; confirmation < 3; ++confirmation) {
            U8 confirmed = 0;
            std::string confirmationReason;
            if (!read_chunk(address + index, 1U, &confirmed, &confirmationReason)) {
              result.address = address + index;
              result.reason = confirmationReason.empty() ? "target returned an incomplete mismatch confirmation read" : confirmationReason;
              result.gateErrorCode = "ARTIFACT_MATCH_READ_INCOMPLETE";
              return result;
            }
            if (confirmed != range.expected[offset + index]) confirmedExpected = false;
          }
          if (confirmedExpected) {
            ++result.transientMismatches;
            continue;
          }
          result.status = ArtifactMatchStatus::mismatch;
          result.address = address + index;
          result.reason = "target nonvolatile byte differs from the selected Artifact generation";
          result.gateErrorCode = "ARTIFACT_MATCH_MISMATCH";
          return result;
        }
      }
    }
  }
  if (result.bytesCompared == manifest.totalBytes) {
    result.status = ArtifactMatchStatus::verified;
    result.reason = "all Artifact-defined nonvolatile file-backed bytes matched";
  }
  return result;
}

static const char* artifact_match_status_text(ArtifactMatchStatus status) {
  if (status == ArtifactMatchStatus::verified) return "verified";
  if (status == ArtifactMatchStatus::mismatch) return "mismatch";
  return "unverified";
}

static void write_artifact_match_evidence(
    const ArtifactMatchManifest& manifest,
    const std::string& manifest_sha256,
    const ArtifactMatchResult& result) {
  std::cout
    << ",\"targetArtifactMatch\":\"" << artifact_match_status_text(result.status) << "\""
    << ",\"artifactMatch\":{\"historyOnly\":false"
    << ",\"captureId\":\"" << escape(manifest.captureId) << "\""
    << ",\"helperPid\":" << GetCurrentProcessId()
    << ",\"connectOrdinal\":" << manifest.connectOrdinal
    << ",\"runtimeIdentitySha256\":\"" << manifest.runtimeIdentitySha256 << "\""
    << ",\"artifactGeneration\":\"" << manifest.artifactGeneration << "\""
    << ",\"artifactSha256\":\"" << manifest.artifactSha256 << "\""
    << ",\"manifestSha256\":\"" << manifest_sha256 << "\""
    << ",\"rangeCount\":" << manifest.ranges.size()
    << ",\"totalBytes\":" << manifest.totalBytes
    << ",\"bytesCompared\":" << result.bytesCompared
    << ",\"transientMismatches\":" << result.transientMismatches
    << ",\"address\":\"" << hex_u32(result.address) << "\""
    << ",\"captureAllowed\":" << (artifact_match_capture_allowed(result) ? "true" : "false")
    << ",\"writeAllowed\":" << (artifact_match_write_allowed(result) ? "true" : "false")
    << ",\"gateErrorCode\":\"" << escape(result.gateErrorCode) << "\""
    << ",\"reason\":\"" << escape(result.reason) << "\"}";
}

static void stream_artifact_match(
    const std::string& capture_id,
    int64_t qpc,
    const ArtifactMatchManifest& manifest,
    const std::string& manifest_sha256,
    const ArtifactMatchResult& result) {
  std::cout << "{\"record\":\"artifact_match\",\"captureId\":\"" << escape(capture_id)
            << "\",\"qpcCounter\":\"" << qpc << "\"";
  write_artifact_match_evidence(manifest, manifest_sha256, result);
  std::cout << "}\n" << std::flush;
}

static void artifact_match_gate_error(
    const std::string& code,
    const std::string& reason,
    const std::string& capture_id,
    const std::string& manifest_sha256,
    const ArtifactMatchManifest* manifest = nullptr,
    const ArtifactMatchResult* result = nullptr,
    int64_t qpc_epoch = -1,
    int64_t qpc_frequency = -1) {
  std::cout
    << "{\"record\":\"result\",\"status\":\"error\",\"errorCode\":\"" << escape(code)
    << "\",\"reason\":\"" << escape(reason)
    << "\",\"captureId\":\"" << escape(capture_id)
    << "\",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
    << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",\"helperPid\":" << GetCurrentProcessId()
    << ",\"manifestSha256\":\"" << escape(manifest_sha256)
    << "\",\"hssStartIssued\":false,\"rawOpened\":false";
  if (qpc_epoch >= 0 && qpc_frequency > 0) {
    std::cout << ",\"qpcEpochCounter\":\"" << qpc_epoch
              << "\",\"qpcFrequency\":\"" << qpc_frequency << "\"";
  }
  if (manifest && result) write_artifact_match_evidence(*manifest, manifest_sha256, *result);
  std::cout << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
}

static void write_text_file_a(const std::string& path, const std::string& text) {
  const std::string temporary = path + ".tmp";
  {
    std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
    file << text;
  }
  MoveFileExA(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING);
}

static bool suppress_jlink_gui(JLINKARM_ExecCommand_Fn arm_exec, bool* crashed) {
  char out[512] = {};
  (void)call_exec(arm_exec, "SuppressGUI = 1", out, sizeof(out), crashed);
  return !*crashed;
}

static int connect_preflight(const std::wstring& dll_path, const std::map<std::wstring, std::wstring>& options) {
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  const std::string dll_utf8 = narrow(dll_path);
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }

  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  auto arm_sn = reinterpret_cast<JLINKARM_GetSN_Fn>(required(dll, "JLINKARM_GetSN"));
  auto arm_id = reinterpret_cast<JLINKARM_GetId_Fn>(required(dll, "JLINKARM_GetId"));
  auto arm_halted = reinterpret_cast<JLINKARM_IsHalted_Fn>(required(dll, "JLINKARM_IsHalted"));

  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect) {
    FreeLibrary(dll);
    error_json("JLINK_BASE_EXPORT_MISSING", "required JLINKARM base exports missing", dll_utf8);
    return 0;
  }

  const std::string device = option_utf8(options, L"--device", "");
  const std::string iface = option_utf8(options, L"--interface", "SWD");
  const std::string serial_text = option_utf8(options, L"--serial", "");
  const int speed = std::stoi(option_utf8(options, L"--speed", "4000"));
  const int tif = iface == "JTAG" ? 0 : 1;
  bool crashed = false;
  int select_sn_rc = 0;
  if (!serial_text.empty() && arm_select_sn) {
    select_sn_rc = call_select_sn(arm_select_sn, static_cast<U32>(std::stoul(serial_text)), &crashed);
    if (crashed) {
      FreeLibrary(dll);
      error_json("JLINK_SELECT_SN_EXCEPTION", "JLINKARM_EMU_SelectByUSBSN raised a structured exception", dll_utf8);
      return 0;
    }
  }

  int open_rc = call_int0(arm_open, &crashed);
  if (crashed) {
    FreeLibrary(dll);
    error_json("JLINK_OPEN_EXCEPTION", "JLINKARM_Open raised a structured exception", dll_utf8);
    return 0;
  }
  if (!suppress_jlink_gui(arm_exec, &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_SUPPRESS_GUI_EXCEPTION", "JLINKARM_ExecCommand(SuppressGUI) raised a structured exception", dll_utf8);
    return 0;
  }

  char exec_out[512] = {};
  std::string device_cmd = "device = " + device;
  int device_rc = call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_EXEC_DEVICE_EXCEPTION", "JLINKARM_ExecCommand(device) raised a structured exception", dll_utf8);
    return 0;
  }
  int tif_rc = call_int1(arm_tif, tif, &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_TIF_SELECT_EXCEPTION", "JLINKARM_TIF_Select raised a structured exception", dll_utf8);
    return 0;
  }

  call_void1(arm_speed, speed, &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_SET_SPEED_EXCEPTION", "JLINKARM_SetSpeed raised a structured exception", dll_utf8);
    return 0;
  }

  int connect_rc = call_int0(arm_connect, &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_CONNECT_EXCEPTION", "JLINKARM_Connect raised a structured exception", dll_utf8);
    return 0;
  }

  int halted = -1;
  if (arm_halted) {
    halted = call_int0(arm_halted, &crashed);
    if (crashed) halted = -2;
  }
  U32 sn = 0;
  if (arm_sn) {
    sn = call_u320(arm_sn, &crashed);
    if (crashed) sn = 0;
  }
  U32 target_id = 0;
  if (arm_id) {
    target_id = call_u320(arm_id, &crashed);
    if (crashed) target_id = 0;
  }
  int dll_version = 0;
  if (arm_version) {
    dll_version = call_int0(arm_version, &crashed);
    if (crashed) dll_version = 0;
  }
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);

  std::cout
    << "{\"status\":\"" << (connect_rc >= 0 ? "ok" : "error")
    << "\",\"device\":\"" << escape(device)
    << "\",\"interface\":\"" << escape(iface)
    << "\",\"speedKhz\":" << speed
    << ",\"serial\":\"" << escape(serial_text)
    << "\",\"dll\":\"" << escape(dll_utf8)
    << "\",\"dllVersion\":" << dll_version
    << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
    << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",\"firmware\":\"unknown\""
    << ",\"vtrefMv\":null"
    << ",\"targetId\":" << target_id
    << ",\"probeSerial\":" << sn
    << ",\"returnCodes\":{\"selectSerial\":" << select_sn_rc
    << ",\"open\":" << open_rc
    << ",\"device\":" << device_rc
    << ",\"tifSelect\":" << tif_rc
    << ",\"connect\":" << connect_rc
    << "},\"execOutput\":\"" << escape(exec_out)
    << "\",\"targetWasHalted\":" << (halted > 0 ? "true" : "false")
    << ",\"targetWasHaltedRaw\":" << halted
    << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false"
    << ",\"baseApiCandidate\":\"AUTHORIZED_UNVERIFIED_BASE_API_CANDIDATE\"}";
  return 0;
}

static int read_ram_probe(const std::wstring& dll_path, const std::map<std::wstring, std::wstring>& options) {
  const std::string dll_utf8 = narrow(dll_path);
  if (dll_path.empty()) {
    error_json("HSS_DLL_PATH_MISSING", "--dll is required");
    return 0;
  }
  const std::string address_text = option_utf8(options, L"--address", "");
  U32 address = 0;
  if (!parse_u32_text(address_text, &address)) {
    error_json("HSS_READ_RAM_ADDRESS_INVALID", "--address must be a 32-bit integer");
    return 0;
  }
  int size = 4;
  int samples = 2;
  int interval_ms = 100;
  if (!parse_int_text(option_utf8(options, L"--size", "4"), &size) || size < 1 || size > 256) {
    error_json("HSS_READ_RAM_SIZE_INVALID", "--size must be 1..256 bytes");
    return 0;
  }
  if (!parse_int_text(option_utf8(options, L"--samples", "2"), &samples) || samples < 1 || samples > 1000) {
    error_json("HSS_READ_RAM_SAMPLES_INVALID", "--samples must be 1..1000");
    return 0;
  }
  if (!parse_int_text(option_utf8(options, L"--interval-ms", "100"), &interval_ms) || interval_ms < 0 || interval_ms > 60000) {
    error_json("HSS_READ_RAM_INTERVAL_INVALID", "--interval-ms must be 0..60000");
    return 0;
  }

  HMODULE dll = LoadLibraryW(dll_path.c_str());
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }

  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_halted = reinterpret_cast<JLINKARM_IsHalted_Fn>(required(dll, "JLINKARM_IsHalted"));
  auto arm_go = reinterpret_cast<JLINKARM_Go_Fn>(required(dll, "JLINKARM_Go"));
  auto arm_read_mem = reinterpret_cast<JLINKARM_ReadMem_Fn>(required(dll, "JLINKARM_ReadMem"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !arm_read_mem) {
    FreeLibrary(dll);
    error_json("JLINK_BASE_EXPORT_MISSING", "required JLINKARM read-memory exports missing", dll_utf8);
    return 0;
  }

  const std::string device = option_utf8(options, L"--device", "");
  const std::string iface = option_utf8(options, L"--interface", "SWD");
  const std::string serial_text = option_utf8(options, L"--serial", "");
  const bool resume_before_read = option_utf8(options, L"--resume-before-read", "false") == "true";
  int speed = 4000;
  if (!parse_int_text(option_utf8(options, L"--speed", "4000"), &speed) || speed < 1) {
    FreeLibrary(dll);
    error_json("HSS_READ_RAM_SPEED_INVALID", "--speed must be positive", dll_utf8);
    return 0;
  }

  bool crashed = false;
  int select_sn_rc = 0;
  if (!serial_text.empty() && arm_select_sn) {
    select_sn_rc = call_select_sn(arm_select_sn, static_cast<U32>(std::stoul(serial_text)), &crashed);
    if (crashed) {
      FreeLibrary(dll);
      error_json("JLINK_SELECT_SN_EXCEPTION", "JLINKARM_EMU_SelectByUSBSN raised a structured exception", dll_utf8);
      return 0;
    }
  }

  int open_rc = call_int0(arm_open, &crashed);
  if (crashed || open_rc < 0) {
    FreeLibrary(dll);
    error_json("JLINK_OPEN_FAILED", "JLINKARM_Open failed", dll_utf8);
    return 0;
  }

  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  int device_rc = call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_EXEC_DEVICE_EXCEPTION", "JLINKARM_ExecCommand(device) raised a structured exception", dll_utf8);
    return 0;
  }
  const int tif = iface == "JTAG" ? 0 : 1;
  int tif_rc = call_int1(arm_tif, tif, &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_TIF_SELECT_EXCEPTION", "JLINKARM_TIF_Select raised a structured exception", dll_utf8);
    return 0;
  }
  call_void1(arm_speed, speed, &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_SET_SPEED_EXCEPTION", "JLINKARM_SetSpeed raised a structured exception", dll_utf8);
    return 0;
  }
  int connect_rc = call_int0(arm_connect, &crashed);
  if (crashed || connect_rc < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_CONNECT_FAILED", "JLINKARM_Connect failed", dll_utf8);
    return 0;
  }

  int halted = -1;
  if (arm_halted) {
    halted = call_int0(arm_halted, &crashed);
    if (crashed) halted = -2;
  }

  bool resume_issued = false;
  int halted_after_resume = -1;
  if (resume_before_read) {
    if (!arm_go) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("JLINK_GO_EXPORT_MISSING", "JLINKARM_Go export missing", dll_utf8);
      return 0;
    }
    call_void0(arm_go, &crashed);
    if (crashed) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("JLINK_GO_EXCEPTION", "JLINKARM_Go raised a structured exception", dll_utf8);
      return 0;
    }
    resume_issued = true;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    if (arm_halted) {
      halted_after_resume = call_int0(arm_halted, &crashed);
      if (crashed) halted_after_resume = -2;
    }
  }

  std::vector<unsigned char> first_value;
  bool changed = false;
  bool all_zero = true;
  bool read_failed = false;
  std::cout
    << "{\"status\":\"ok\",\"command\":\"read-ram-probe\",\"api\":\"JLINKARM_ReadMem\""
    << ",\"dll\":\"" << escape(dll_utf8)
    << "\",\"device\":\"" << escape(device)
    << "\",\"interface\":\"" << escape(iface)
    << "\",\"speedKhz\":" << speed
    << ",\"address\":\"" << hex_u32(address)
    << "\",\"size\":" << size
    << ",\"sampleCount\":" << samples
    << ",\"intervalMs\":" << interval_ms
    << ",\"returnCodes\":{\"selectSerial\":" << select_sn_rc
    << ",\"open\":" << open_rc
    << ",\"device\":" << device_rc
    << ",\"tifSelect\":" << tif_rc
    << ",\"connect\":" << connect_rc
    << "},\"execOutput\":\"" << escape(exec_out)
    << "\",\"targetWasHalted\":" << (halted > 0 ? "true" : "false")
    << ",\"targetWasHaltedRaw\":" << halted
    << ",\"resumeBeforeRead\":" << (resume_before_read ? "true" : "false")
    << ",\"resumeIssued\":" << (resume_issued ? "true" : "false")
    << ",\"targetWasHaltedAfterResume\":" << (halted_after_resume > 0 ? "true" : "false")
    << ",\"targetWasHaltedAfterResumeRaw\":" << halted_after_resume
    << ",\"samples\":[";
  for (int sample = 0; sample < samples; ++sample) {
    std::vector<unsigned char> buffer(static_cast<size_t>(size), 0);
    const int read_rc = call_read_mem(arm_read_mem, address, static_cast<U32>(size), buffer.data(), &crashed);
    const bool valid = !crashed && read_rc >= 0;
    if (!valid) read_failed = true;
    if (valid) {
      if (first_value.empty()) first_value = buffer;
      else if (buffer != first_value) changed = true;
      for (unsigned char byte : buffer) {
        if (byte != 0) all_zero = false;
      }
    }
    U32 scalar = 0;
    const int scalar_bytes = (std::min)(size, 4);
    for (int byte = 0; byte < scalar_bytes; ++byte) scalar |= static_cast<U32>(buffer[static_cast<size_t>(byte)]) << (byte * 8);
    if (sample > 0) std::cout << ",";
    std::cout
      << "{\"index\":" << sample
      << ",\"readReturnCode\":" << read_rc
      << ",\"valid\":" << (valid ? "true" : "false")
      << ",\"value\":" << scalar
      << ",\"valueHex\":\"" << hex_u32(scalar)
      << "\",\"bytes\":\"" << bytes_hex(buffer)
      << "\"}";
    if (crashed) break;
    if (sample + 1 < samples && interval_ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
  }
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);
  std::cout
    << "],\"changed\":" << (changed ? "true" : "false")
    << ",\"allZero\":" << (all_zero ? "true" : "false")
    << ",\"readFailed\":" << (read_failed ? "true" : "false")
    << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return 0;
}

struct R4MemoryTransactionResult {
  bool ok = false;
  bool writeIssued = false;
  std::string errorCode;
  std::vector<unsigned char> oldBytes;
  std::vector<unsigned char> readbackBytes;
};

using R4MemoryRead = std::function<bool(U32, int, std::vector<unsigned char>*)>;
using R4MemoryWrite = std::function<bool(U32, const std::vector<unsigned char>&)>;

static R4MemoryTransactionResult execute_r4_memory_transaction(
    ArtifactMatchStatus artifact_status,
    U32 address,
    const std::vector<unsigned char>& requested,
    const R4MemoryRead& read,
    const R4MemoryWrite& write) {
  R4MemoryTransactionResult result;
  if (artifact_status != ArtifactMatchStatus::unverified) {
    result.errorCode = artifact_status == ArtifactMatchStatus::mismatch ? "ARTIFACT_MATCH_MISMATCH" : "HSS_R4_ARTIFACT_STATE_INVALID";
    return result;
  }
  if (!read(address, static_cast<int>(requested.size()), &result.oldBytes)) { result.errorCode = "JLINK_READMEM_FAILED"; return result; }
  result.writeIssued = true;
  if (!write(address, requested)) { result.errorCode = "JLINK_WRITEMEM_FAILED"; return result; }
  if (!read(address, static_cast<int>(requested.size()), &result.readbackBytes)) { result.errorCode = "READBACK_FAILED"; return result; }
  if (result.readbackBytes != requested) { result.errorCode = "READBACK_MISMATCH"; return result; }
  result.ok = true;
  return result;
}

static StrictJson strict_json_string(const std::string& text) {
  StrictJson value;
  value.type = StrictJson::Type::string;
  value.text = text;
  return value;
}

static bool resummarize_r4_fixture(StrictJson* root) {
  StrictJson* approval = &root->objectValue["approval"];
  std::string approval_digest;
  std::string reason;
  if (!r4_compute_approval_digest(*root, &approval_digest, &reason)) return false;
  approval->objectValue["operationDigest"] = strict_json_string(approval_digest);
  root->objectValue.erase("summarySha256");
  std::string summary;
  if (!sha256_bytes(canonical_json(*root), &summary)) return false;
  root->objectValue["summarySha256"] = strict_json_string(summary);
  return true;
}

static std::string r4_fixture_envelope(const std::string& artifact_match = "unverified", bool policy_exception = true) {
  const std::string body =
    "{\"schema\":\"jlink-mcp-r4-native-exception\",\"version\":1,\"kind\":\"unverified_variable_write\","
    "\"canonicalization\":\"utf8-sorted-json-v1\",\"summaryAlgorithm\":\"sha256\","
    "\"operation\":{\"tool\":\"variable_write_execute\",\"writePlanId\":\"op_22222222-2222-4222-8222-222222222222\","
    "\"planDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"planIssuedAt\":\"2026-07-17T00:00:00.000Z\",\"planExpiresAt\":\"2026-07-17T00:01:00.000Z\","
    "\"canonicalArgs\":{\"targetRef\":{\"kind\":\"scalar\",\"path\":\"Debug_R4\"},\"canonicalTarget\":\"Debug_R4\",\"values\":[42]}},"
    "\"approval\":{\"state\":\"consumed\",\"challengeId\":\"11111111-1111-4111-8111-111111111111\","
    "\"operationDigest\":\"0000000000000000000000000000000000000000000000000000000000000000\","
    "\"nonceSha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
    "\"consumedAt\":\"2026-07-17T00:00:01.000Z\",\"expiresAt\":\"2026-07-17T00:01:00.000Z\"},"
    "\"binding\":{\"target\":{\"targetId\":\"MCU\",\"artifactMatch\":" + canonical_json_string(artifact_match) + "},"
    "\"probe\":{\"kind\":\"jlink\",\"serial\":\"123\",\"interface\":\"SWD\",\"speedKhz\":4000},"
    "\"runtime\":{\"identitySha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\","
    "\"scriptApprovalSha256\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"},"
    "\"artifact\":{\"generation\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\","
    "\"sha256\":\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\","
    "\"evidenceGeneration\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\"},"
    "\"layoutSha256\":\"1111111111111111111111111111111111111111111111111111111111111111\","
    "\"policy\":{\"sha256\":\"3333333333333333333333333333333333333333333333333333333333333333\",\"rule\":\"Debug_R4\","
    "\"unverifiedWriteException\":" + std::string(policy_exception ? "true" : "false") + ",\"maxWrites\":1,\"remainingWrites\":1,\"maxElements\":1,\"remainingElements\":1},"
    "\"session\":{\"id\":\"session\",\"captureId\":\"outside-capture\",\"captureGeneration\":0},\"physicalConnectionGeneration\":7},"
    "\"write\":{\"canonicalTarget\":\"Debug_R4\",\"address\":536870912,\"accessSize\":4,\"byteLength\":4,\"bytesHex\":\"2a000000\",\"readbackRequired\":true}}";
  StrictJson root;
  std::string reason;
  if (!StrictJsonParser(body).parse(&root, &reason) || !resummarize_r4_fixture(&root)) return "";
  return canonical_json(root);
}

static R4CommandBindings r4_fixture_bindings(const std::string& envelope) {
  StrictJson root;
  std::string reason;
  std::string summary;
  (void)StrictJsonParser(envelope).parse(&root, &reason);
  (void)json_text(json_member(root, "summarySha256"), &summary);
  return {
    "", summary, "MCU", "SWD", "123", 4000, "outside-capture",
    std::string(64U, 'c'), std::string(64U, 'e'), std::string(64U, 'f'),
    "0x20000000", 4, 4, "2a000000", false,
  };
}

static int self_test() {
  U32 parsed_u32 = 0;
  int parsed_int = 0;
  JlinkScriptSelection no_script;
  JlinkScriptSelection rejected_script;
  std::string script_error_code;
  std::string script_error_reason;
  char script_output[1] = {1};
  int script_return_code = -1;
  bool script_crashed = true;
  if (!prepare_jlink_script("none", L"", "", &no_script, &script_error_code, &script_error_reason)
      || !apply_jlink_script(nullptr, no_script, &script_return_code, script_output, sizeof(script_output), &script_crashed)
      || script_return_code != 0 || script_crashed || script_output[0] != '\0'
      || prepare_jlink_script("", L"", "", &rejected_script, &script_error_code, &script_error_reason)
      || prepare_jlink_script("none", L"C:\\conflict.jlinkscript", "", &rejected_script, &script_error_code, &script_error_reason)) {
    error_json("HSS_SELF_TEST_SCRIPT_MODE_FAILED", "J-Link script mode boundary failed");
    return 0;
  }
  if (!parse_u32_text("0x20000004", &parsed_u32) || parsed_u32 != 0x20000004U || parse_u32_text("0x100000000", &parsed_u32)) {
    error_json("HSS_SELF_TEST_PARSE_U32_FAILED", "uint32 option parsing failed");
    return 0;
  }
  if (!parse_int_text("100", &parsed_int) || parsed_int != 100 || parse_int_text("100ms", &parsed_int)) {
    error_json("HSS_SELF_TEST_PARSE_INT_FAILED", "integer option parsing failed");
    return 0;
  }
  if (sample_due_ns(1000, 0, 1000) != 1001000 || sample_due_ns(1000, 2, 1000) != 3001000) {
    error_json("HSS_SELF_TEST_TIMING_FAILED", "sample pacing calculation failed");
    return 0;
  }
  int64_t live_qpc = 0;
  int64_t live_frequency = 0;
  int64_t parsed_qpc = 0;
  uint64_t first_epoch_tick = 0;
  uint64_t second_epoch_tick = 0;
  if (!query_qpc_timebase(&live_qpc, &live_frequency) || live_qpc < 0 || live_frequency <= 0
      || !parse_qpc_decimal("123456789", &parsed_qpc) || parsed_qpc != 123456789
      || parse_qpc_decimal("", &parsed_qpc) || parse_qpc_decimal("-1", &parsed_qpc)
      || parse_qpc_decimal("9223372036854775808", &parsed_qpc)
      || !qpc_delta_ns(1250, 1000, 1000, &first_epoch_tick) || first_epoch_tick != 250000000U
      || !qpc_delta_ns(2250, 2000, 1000, &second_epoch_tick) || second_epoch_tick != first_epoch_tick
      || qpc_delta_ns(999, 1000, 1000, &first_epoch_tick) || qpc_delta_ns(1000, 1000, 0, &first_epoch_tick)) {
    error_json("HSS_SELF_TEST_QPC_TIMEBASE_FAILED", "QPC validation or cross-epoch nanosecond conversion failed");
    return 0;
  }
  const std::string r4_envelope = r4_fixture_envelope();
  const R4CommandBindings r4_bindings = r4_fixture_bindings(r4_envelope);
  R4NativeException parsed_r4;
  std::string r4_reason;
  StrictJson missing_r4;
  StrictJson extra_r4;
  if (r4_envelope.empty() || !validate_r4_native_exception(r4_envelope, r4_bindings, &parsed_r4, &r4_reason)
      || !StrictJsonParser(r4_envelope).parse(&missing_r4, &r4_reason)
      || !StrictJsonParser(r4_envelope).parse(&extra_r4, &r4_reason)) {
    error_json("HSS_SELF_TEST_R4_ENVELOPE_FAILED", r4_reason.empty() ? "valid R4 envelope was rejected" : r4_reason);
    return 0;
  }
  missing_r4.objectValue.erase("approval");
  StrictJson extra_value;
  extra_value.type = StrictJson::Type::boolean;
  extra_value.booleanValue = true;
  extra_r4.objectValue["callerAuthorization"] = extra_value;
  std::string tampered_r4 = r4_envelope;
  const size_t tampered_bytes = tampered_r4.find("2a000000");
  if (tampered_bytes == std::string::npos) {
    error_json("HSS_SELF_TEST_R4_ENVELOPE_FAILED", "R4 fixture bytes are missing");
    return 0;
  }
  tampered_r4.replace(tampered_bytes, 8U, "00000000");
  std::string noncanonical_r4 = r4_envelope;
  const size_t version = noncanonical_r4.find("\"version\":1");
  if (version == std::string::npos) {
    error_json("HSS_SELF_TEST_R4_ENVELOPE_FAILED", "R4 fixture version is missing");
    return 0;
  }
  noncanonical_r4.replace(version, sizeof("\"version\":1") - 1U, "\"version\":1.0");
  R4CommandBindings wrong_r4_binding = r4_bindings;
  wrong_r4_binding.device = "OTHER";
  R4NativeException rejected_r4;
  if (validate_r4_native_exception(canonical_json(missing_r4), r4_bindings, &rejected_r4, &r4_reason)
      || validate_r4_native_exception(canonical_json(extra_r4), r4_bindings, &rejected_r4, &r4_reason)
      || validate_r4_native_exception(tampered_r4, r4_bindings, &rejected_r4, &r4_reason)
      || validate_r4_native_exception(noncanonical_r4, r4_bindings, &rejected_r4, &r4_reason)
      || validate_r4_native_exception(r4_envelope, wrong_r4_binding, &rejected_r4, &r4_reason)
      || validate_r4_native_exception(r4_fixture_envelope("verified"), r4_fixture_bindings(r4_fixture_envelope("verified")), &rejected_r4, &r4_reason)
      || validate_r4_native_exception(r4_fixture_envelope("mismatch"), r4_fixture_bindings(r4_fixture_envelope("mismatch")), &rejected_r4, &r4_reason)
      || validate_r4_native_exception(r4_fixture_envelope("unverified", false), r4_fixture_bindings(r4_fixture_envelope("unverified", false)), &rejected_r4, &r4_reason)) {
    error_json("HSS_SELF_TEST_R4_REJECTION_FAILED", "invalid R4 envelope or binding did not fail closed");
    return 0;
  }
  int r4_reads = 0;
  int r4_writes = 0;
  std::vector<unsigned char> r4_memory{0U, 0U, 0U, 0U};
  const auto r4_read = [&](U32 address, int length, std::vector<unsigned char>* bytes) {
    ++r4_reads;
    if (address != 0x20000000U || length != 4) return false;
    *bytes = r4_memory;
    return true;
  };
  const auto r4_write = [&](U32 address, const std::vector<unsigned char>& bytes) {
    ++r4_writes;
    if (address != 0x20000000U || bytes.size() != 4U) return false;
    r4_memory = bytes;
    return true;
  };
  const auto verified_rejection = execute_r4_memory_transaction(ArtifactMatchStatus::verified, 0x20000000U, {0x2AU, 0U, 0U, 0U}, r4_read, r4_write);
  const auto mismatch_rejection = execute_r4_memory_transaction(ArtifactMatchStatus::mismatch, 0x20000000U, {0x2AU, 0U, 0U, 0U}, r4_read, r4_write);
  if (verified_rejection.writeIssued || mismatch_rejection.writeIssued || r4_reads != 0 || r4_writes != 0) {
    error_json("HSS_SELF_TEST_R4_ZERO_SIDE_EFFECT_FAILED", "verified or mismatch R4 rejection reached memory access");
    return 0;
  }
  const auto r4_transaction = execute_r4_memory_transaction(ArtifactMatchStatus::unverified, 0x20000000U, {0x2AU, 0U, 0U, 0U}, r4_read, r4_write);
  if (!r4_transaction.ok || !r4_transaction.writeIssued || r4_reads != 2 || r4_writes != 1
      || r4_transaction.oldBytes != std::vector<unsigned char>({0U, 0U, 0U, 0U})
      || r4_transaction.readbackBytes != std::vector<unsigned char>({0x2AU, 0U, 0U, 0U})) {
    error_json("HSS_SELF_TEST_R4_READBACK_FAILED", "R4 same-connection transaction did not read old value, write once, and read back");
    return 0;
  }
  if (hss_buffer_overwritten({0xA5, 0xA5}, 0xA5) || !hss_buffer_overwritten({0xA5, 0x00}, 0xA5)) {
    error_json("HSS_SELF_TEST_SENTINEL_FAILED", "HSS read buffer sentinel check failed");
    return 0;
  }
  if (hss_sample_prefix_overwritten({0xA5, 0xA5, 0x00}, 2, 0xA5) || !hss_sample_prefix_overwritten({0xA5, 0x00, 0xA5}, 2, 0xA5)) {
    error_json("HSS_SELF_TEST_PREFIX_FAILED", "HSS sample prefix sentinel check failed");
    return 0;
  }
  if (hss_first_changed_offset({0xA5, 0xA5, 0x00}, 0xA5) != 2 || bytes_hex(hss_changed_window({0xA5, 0xA5, 0x00, 0x01}, 2)) != "0001") {
    error_json("HSS_SELF_TEST_CHANGED_WINDOW_FAILED", "HSS changed-window diagnostic failed");
    return 0;
  }
  if (hss_capture_failed(false, 2) || !hss_capture_failed(false, 0) || !hss_capture_failed(true, 2)) {
    error_json("HSS_SELF_TEST_CAPTURE_FAILURE_FAILED", "HSS capture failure classification failed");
    return 0;
  }
  HssRecordSequence normal_sequence;
  uint32_t normal_flags = 0;
  if (observe_hss_sample(&normal_sequence, 84U, &normal_flags) != HssSampleDecision::emit || normal_flags != 1U
      || observe_hss_sample(&normal_sequence, 85U, &normal_flags) != HssSampleDecision::emit || normal_flags != 1U
      || observe_hss_sample(&normal_sequence, 86U, &normal_flags) != HssSampleDecision::emit || normal_flags != 1U
      || normal_sequence.emittedSamples != 3 || normal_sequence.duplicateSamples != 0 || normal_sequence.droppedSamples != 0 || normal_sequence.invalid) {
    error_json("HSS_SELF_TEST_RECORD_SEQUENCE_FAILED", "normal HSS record sequence classification failed");
    return 0;
  }
  HssRecordSequence gap_sequence;
  uint32_t gap_flags = 0;
  if (observe_hss_sample(&gap_sequence, 86U, &gap_flags) != HssSampleDecision::emit || gap_flags != 1U
      || observe_hss_sample(&gap_sequence, 88U, &gap_flags) != HssSampleDecision::emit || gap_flags != (1U | (1U << 4))
      || observe_hss_sample(&gap_sequence, 88U, &gap_flags) != HssSampleDecision::duplicate
      || gap_sequence.emittedSamples != 2 || gap_sequence.duplicateSamples != 1 || gap_sequence.droppedSamples != 1 || gap_sequence.invalid) {
    error_json("HSS_SELF_TEST_RECORD_GAP_FAILED", "HSS gap and duplicate classification failed");
    return 0;
  }
  HssRecordSequence decreasing_sequence;
  uint32_t decreasing_flags = 0;
  if (observe_hss_sample(&decreasing_sequence, 88U, &decreasing_flags) != HssSampleDecision::emit
      || observe_hss_sample(&decreasing_sequence, 87U, &decreasing_flags) != HssSampleDecision::invalid
      || !decreasing_sequence.invalid || decreasing_sequence.emittedSamples != 1) {
    error_json("HSS_SELF_TEST_RECORD_DECREASING_FAILED", "decreasing HSS record sequence was not rejected");
    return 0;
  }
  PostConnectStabilityEvidence recovery_restart;
  if (observe_post_connect_counter(&recovery_restart, 9350U, 1, 0, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&recovery_restart, 9350U, 100000000, 100, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&recovery_restart, 0U, 100000000, 200, 250, 2, 8000.0, 24000.0) != PostConnectDecision::recoveryRestart
      || observe_post_connect_counter(&recovery_restart, 1600U, 100000000, 300, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&recovery_restart, 3200U, 100000000, 400, 250, 2, 8000.0, 24000.0) != PostConnectDecision::stable) {
    error_json("HSS_SELF_TEST_POST_CONNECT_RECOVERY_FAILED", "recovery-window counter restart did not reset the post-connect baseline");
    return 0;
  }
  PostConnectStabilityEvidence late_decrease;
  if (observe_post_connect_counter(&late_decrease, 9350U, 1, 0, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&late_decrease, 0U, 300000000, 300, 250, 2, 8000.0, 24000.0) != PostConnectDecision::nonWrappingDecrease) {
    error_json("HSS_SELF_TEST_POST_CONNECT_DECREASE_FAILED", "post-recovery non-wrapping counter decrease was not rejected");
    return 0;
  }
  PostConnectStabilityEvidence interrupted_window;
  if (observe_post_connect_counter(&interrupted_window, 0U, 1, 0, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&interrupted_window, 1600U, 100000000, 100, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&interrupted_window, 1600U, 50000000, 150, 250, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&interrupted_window, 0U, 50000000, 200, 250, 2, 8000.0, 24000.0) != PostConnectDecision::nonWrappingDecrease) {
    error_json("HSS_SELF_TEST_POST_CONNECT_INTERRUPTED_WINDOW_FAILED", "a decrease after an interrupted running window was not rejected");
    return 0;
  }
  PostConnectStabilityEvidence valid_wrap;
  if (observe_post_connect_counter(&valid_wrap, 0xFFFFFF00U, 1, 0, 0, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&valid_wrap, 0x00000540U, 100000000, 100, 0, 2, 8000.0, 24000.0) != PostConnectDecision::pending
      || observe_post_connect_counter(&valid_wrap, 0x00000B80U, 100000000, 200, 0, 2, 8000.0, 24000.0) != PostConnectDecision::stable) {
    error_json("HSS_SELF_TEST_POST_CONNECT_WRAP_FAILED", "rate-valid uint32 wrap was not accepted");
    return 0;
  }
  const auto block_plan = build_hss_block_plan({
    {"counter", 0x20006B28U, 4},
    {"pattern", 0x20000800U, 4},
    {"raw", 0x20006B2CU, 4},
    {"offset_u", 0x20006C00U, 2},
    {"offset_v", 0x20006C02U, 2},
  });
  if (block_plan.blocks.size() != 3 || block_plan.bytesPerSample != 16 || block_plan.symbolOffsets[0] != 4 || block_plan.symbolOffsets[1] != 0 || block_plan.symbolOffsets[2] != 8 || block_plan.symbolOffsets[3] != 12 || block_plan.symbolOffsets[4] != 14) {
    error_json("HSS_SELF_TEST_BLOCK_PLAN_FAILED", "HSS contiguous block planner failed");
    return 0;
  }
  const std::string match_manifest_text =
    "{\"schema\":\"artifact-match-v0\",\"historyOnly\":false,\"captureId\":\"11111111-1111-4111-8111-111111111111\","
    "\"targetId\":\"fixture\",\"probeSerial\":\"123\",\"runtimeIdentitySha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"artifactGeneration\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
    "\"artifactSha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\","
    "\"connectOrdinal\":1,\"totalBytes\":4,\"ranges\":[{\"address\":\"0x8000000\",\"length\":4,\"dataHex\":\"11223344\"}]}";
  ArtifactMatchManifest match_manifest;
  std::string match_reason;
  if (!parse_artifact_match_manifest(match_manifest_text, &match_manifest, &match_reason)) {
    error_json("HSS_SELF_TEST_ARTIFACT_MANIFEST_FAILED", match_reason);
    return 0;
  }
  const std::string unsorted_match_manifest_text =
    "{\"schema\":\"artifact-match-v0\",\"historyOnly\":false,\"captureId\":\"11111111-1111-4111-8111-111111111111\","
    "\"targetId\":\"fixture\",\"probeSerial\":\"123\",\"runtimeIdentitySha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\","
    "\"artifactGeneration\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\","
    "\"artifactSha256\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\","
    "\"connectOrdinal\":1,\"totalBytes\":8,\"ranges\":[{\"address\":\"0x8000004\",\"length\":4,\"dataHex\":\"55667788\"},{\"address\":\"0x8000000\",\"length\":4,\"dataHex\":\"11223344\"}]}";
  ArtifactMatchManifest unsorted_match_manifest;
  if (!parse_artifact_match_manifest(unsorted_match_manifest_text, &unsorted_match_manifest, &match_reason)
      || unsorted_match_manifest.ranges.size() != 2U || unsorted_match_manifest.ranges[0].address != 0x08000000U) {
    error_json("HSS_SELF_TEST_ARTIFACT_MANIFEST_ORDER_FAILED", match_reason);
    return 0;
  }
  std::string overlapping_match_manifest_text = unsorted_match_manifest_text;
  overlapping_match_manifest_text.replace(overlapping_match_manifest_text.rfind("0x8000000"), 9U, "0x8000006");
  ArtifactMatchManifest overlapping_match_manifest;
  if (parse_artifact_match_manifest(overlapping_match_manifest_text, &overlapping_match_manifest, &match_reason)) {
    error_json("HSS_SELF_TEST_ARTIFACT_MANIFEST_OVERLAP_FAILED", "overlapping Artifact ranges did not fail closed");
    return 0;
  }
  std::string match_manifest_sha256;
  const std::string match_directory = "hss_selftest_match_" + std::to_string(GetCurrentProcessId());
  const std::string match_plan_file = match_directory + "\\plan.json";
  const std::string match_manifest_file = match_directory + "\\artifact-match-v0.json";
  std::filesystem::remove_all(match_directory);
  std::filesystem::create_directories(match_directory);
  write_text_file_a(match_plan_file, "{}");
  write_text_file_a(match_manifest_file, match_manifest_text);
  std::wstring match_plan_path;
  std::wstring match_manifest_path;
  ArtifactMatchManifest loaded_match_manifest;
  std::string match_error_code;
  if (!sha256_bytes(match_manifest_text, &match_manifest_sha256)
      || !widen_utf8(match_plan_file, &match_plan_path) || !widen_utf8(match_manifest_file, &match_manifest_path)
      || !load_artifact_match_manifest(
        match_manifest_path,
        match_plan_path,
        match_manifest_sha256,
        match_manifest.captureId,
        match_manifest.targetId,
        match_manifest.probeSerial,
        match_manifest.runtimeIdentitySha256,
        match_manifest.artifactGeneration,
        match_manifest.artifactSha256,
        &loaded_match_manifest,
        &match_error_code,
        &match_reason)) {
    std::filesystem::remove_all(match_directory);
    error_json("HSS_SELF_TEST_ARTIFACT_MANIFEST_LOAD_FAILED", match_reason);
    return 0;
  }
  write_text_file_a(match_manifest_file, match_manifest_text + " ");
  ArtifactMatchManifest tampered_manifest;
  const bool tamper_rejected = !load_artifact_match_manifest(
    match_manifest_path,
    match_plan_path,
    match_manifest_sha256,
    match_manifest.captureId,
    match_manifest.targetId,
    match_manifest.probeSerial,
    match_manifest.runtimeIdentitySha256,
    match_manifest.artifactGeneration,
    match_manifest.artifactSha256,
    &tampered_manifest,
    &match_error_code,
    &match_reason) && match_error_code == "ARTIFACT_MATCH_MANIFEST_HASH_MISMATCH";
  std::filesystem::remove_all(match_directory);
  if (!tamper_rejected) {
    error_json("HSS_SELF_TEST_ARTIFACT_MANIFEST_TAMPER_FAILED", "manifest tamper did not fail closed");
    return 0;
  }
  const ArtifactMatchResult complete_match = compare_artifact_ranges(match_manifest, [](U32 address, U32 count, U8* data, std::string*) {
    const U8 expected[] = {0x11U, 0x22U, 0x33U, 0x44U};
    if (address != 0x08000000U || count != 4U) return false;
    std::copy(std::begin(expected), std::end(expected), data);
    return true;
  });
  const ArtifactMatchResult mismatch = compare_artifact_ranges(match_manifest, [](U32 address, U32 count, U8* data, std::string*) {
    const U8 actual[] = {0x11U, 0x22U, 0x00U, 0x44U};
    if (address == 0x08000000U && count == 4U) std::copy(std::begin(actual), std::end(actual), data);
    else if (address == 0x08000002U && count == 1U) data[0] = 0x00U;
    else return false;
    return true;
  });
  const ArtifactMatchResult transient_mismatch = compare_artifact_ranges(match_manifest, [](U32 address, U32 count, U8* data, std::string*) {
    const U8 expected[] = {0x11U, 0x22U, 0x33U, 0x44U};
    if (address == 0x08000000U && count == 4U) {
      std::copy(std::begin(expected), std::end(expected), data);
      data[2] = 0x00U;
    } else if (address == 0x08000002U && count == 1U) data[0] = 0x33U;
    else return false;
    return true;
  });
  const ArtifactMatchResult partial_read = compare_artifact_ranges(match_manifest, [](U32, U32, U8*, std::string* reason) {
    *reason = "fixture partial read";
    return false;
  });
  ArtifactMatchResult unsupported_reader;
  unsupported_reader.reason = "JLINKARM_ReadMemU8 export is unavailable; read-only capture continued";
  ArtifactMatchConnectionState match_connection;
  const uint64_t first_connect = match_connection.connected();
  const bool first_consumed = match_connection.recordVerified(first_connect) && match_connection.consumeVerified(first_connect);
  const bool replay_rejected = !match_connection.consumeVerified(first_connect);
  const uint64_t second_connect = match_connection.connected();
  if (complete_match.status != ArtifactMatchStatus::verified || complete_match.bytesCompared != 4U
      || !artifact_match_capture_allowed(complete_match) || !artifact_match_write_allowed(complete_match)
      || mismatch.status != ArtifactMatchStatus::mismatch || mismatch.address != 0x08000002U
      || artifact_match_capture_allowed(mismatch) || artifact_match_write_allowed(mismatch)
      || transient_mismatch.status != ArtifactMatchStatus::verified || transient_mismatch.transientMismatches != 1U
      || !artifact_match_capture_allowed(transient_mismatch) || !artifact_match_write_allowed(transient_mismatch)
      || partial_read.status != ArtifactMatchStatus::unverified || partial_read.bytesCompared != 0U
      || partial_read.gateErrorCode != "ARTIFACT_MATCH_READ_INCOMPLETE" || artifact_match_capture_allowed(partial_read)
      || unsupported_reader.status != ArtifactMatchStatus::unverified || !artifact_match_capture_allowed(unsupported_reader)
      || artifact_match_write_allowed(unsupported_reader)
      || !first_consumed || !replay_rejected || second_connect != 2U || match_connection.consumeVerified(second_connect)) {
    error_json("HSS_SELF_TEST_ARTIFACT_MATCH_FAILED", "artifact match completeness or connection consumption failed");
    return 0;
  }
  uint64_t sample_budget = 0;
  if (!capture_sample_budget(16000, 60, &sample_budget) || sample_budget != 960000U
      || capture_sample_budget(16001, 60, &sample_budget) || capture_sample_budget(16000, 61, &sample_budget)) {
    error_json("HSS_SELF_TEST_JCAP_BUDGET_FAILED", "JCAP sample budget boundary failed");
    return 0;
  }
  const std::string temporaryFile = "hss_selftest_" + std::to_string(GetCurrentProcessId()) + ".bin";
  DeleteFileA(temporaryFile.c_str());
  std::wstring temporaryPath;
  if (!widen_utf8(temporaryFile, &temporaryPath)) {
    error_json("HSS_SELF_TEST_WRITE_FAILED", "could not encode temp JCAP path");
    return 0;
  }
  std::string first_frame;
  std::string raw_sha256;
  const std::vector<PlanSymbol> native_symbols{{"counter", 0x20000000U, 4U}, {"pattern", 0x20000004U, 4U}};
  {
    JcapSampleWriter writer;
    if (!writer.open(temporaryPath)
        || writer.append(0U, 0U, 1U, native_symbols, {1U, 2U}, &first_frame) != JcapAppendResult::appended
        || writer.append(1U, 1000000U, 1U, native_symbols, {17U, 18U}) != JcapAppendResult::appended
        || !writer.finalize()) {
      error_json("HSS_SELF_TEST_JCAP_WRITE_FAILED", "deterministic JCAP framing failed");
      return 0;
    }
  }
  const std::string expected_first_frame =
    "{\"formatVersion\":0,\"status\":\"experimental\",\"kind\":\"sample\",\"payloadEncoding\":\"json\",\"payloadBytes\":79,\"payloadSha256\":\"2c6b2742e9ff67a9c2304a380ba8532904f9c5de40e8716dae3028f040c35d52\"}\n"
    "{\"sampleIndex\":0,\"tick\":\"0\",\"statusFlags\":1,\"values\":{\"counter\":1,\"pattern\":2}}\n";
  if (first_frame != expected_first_frame || !sha256_file(temporaryPath, &raw_sha256) || !DeleteFileW(temporaryPath.c_str())) {
    error_json("HSS_SELF_TEST_JCAP_BYTES_FAILED", "JCAP bytes or final close were not deterministic");
    return 0;
  }
  const std::string budgetFile = "hss_selftest_budget_" + std::to_string(GetCurrentProcessId()) + ".bin";
  DeleteFileA(budgetFile.c_str());
  std::wstring budgetPath;
  if (!widen_utf8(budgetFile, &budgetPath)) {
    error_json("HSS_SELF_TEST_JCAP_BUDGET_FAILED", "could not encode budget-stop path");
    return 0;
  }
  {
    JcapSampleWriter writer(1U);
    if (!writer.open(budgetPath)
        || writer.append(0U, 0U, 1U, native_symbols, {1U, 2U}) != JcapAppendResult::budgetExhausted
        || writer.bytes() != 0U || !writer.finalize()) {
      error_json("HSS_SELF_TEST_JCAP_BUDGET_FAILED", "JCAP writer did not stop cleanly at its byte budget");
      return 0;
    }
  }
  if (!DeleteFileW(budgetPath.c_str())) {
    error_json("HSS_SELF_TEST_JCAP_BUDGET_FAILED", "budget-stopped JCAP writer did not close its handle");
    return 0;
  }
  const std::string failureFile = "hss_selftest_failure_" + std::to_string(GetCurrentProcessId()) + ".bin";
  DeleteFileA(failureFile.c_str());
  std::wstring failurePath;
  if (!widen_utf8(failureFile, &failurePath)) {
    error_json("HSS_SELF_TEST_FAILURE_CLOSE_FAILED", "could not encode failure-close path");
    return 0;
  }
  {
    JcapSampleWriter writer;
    if (!writer.open(failurePath) || writer.append(0U, 0U, 1U, native_symbols, {1U}) != JcapAppendResult::failed) {
      error_json("HSS_SELF_TEST_FAILURE_CLOSE_FAILED", "could not exercise failure close");
      return 0;
    }
  }
  if (!DeleteFileW(failurePath.c_str())) {
    error_json("HSS_SELF_TEST_FAILURE_CLOSE_FAILED", "failed JCAP writer did not close its handle");
    return 0;
  }
  std::cout
    << "{\"status\":\"ok\",\"command\":\"self-test\",\"recordFormat\":\"jcap-v0-exact-utf8-envelope\""
    << ",\"sampleCount\":2,\"samplesSha256\":\"" << raw_sha256
    << "\",\"jcapFirstFrameHex\":\"" << hex_bytes(first_frame) << "\""
    << ",\"budgetStopValidated\":true,\"failureCloseValidated\":true,\"qpcTimebaseValidated\":true,\"artifactMatchValidated\":true,\"r4NativeEnvelopeValidated\":true"
    << ",\"recordSemantics\":{\"normalEmitted\":" << normal_sequence.emittedSamples
    << ",\"gapEmitted\":" << gap_sequence.emittedSamples
    << ",\"duplicateSamples\":" << gap_sequence.duplicateSamples
    << ",\"droppedSamples\":" << gap_sequence.droppedSamples
    << ",\"decreasingRejected\":" << (decreasing_sequence.invalid ? "true" : "false") << "}"
    << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return 0;
}

struct HssMemoryIpc {
  std::string requestFile;
  std::string responseFile;
  std::string captureId;
  JLINKARM_ReadMem_Fn readMem = nullptr;
  JLINKARM_WriteMem_Fn writeMem = nullptr;
  JLINKARM_ReadMemU8_Fn readU8 = nullptr;
  JLINKARM_ReadMemU16_Fn readU16 = nullptr;
  JLINKARM_ReadMemU32_Fn readU32 = nullptr;
  JLINKARM_WriteU8_Fn writeU8 = nullptr;
  JLINKARM_WriteU16_Fn writeU16 = nullptr;
  JLINKARM_WriteU32_Fn writeU32 = nullptr;
  JLINKARM_IsHalted_Fn isHalted = nullptr;
  JLINKARM_Go_Fn go = nullptr;
  bool writeAllowed = true;
};

static std::string memory_response_error(const std::string& request_id, const std::string& code, const std::string& reason, bool write_issued, int64_t operation_before_qpc = -1, int64_t operation_after_qpc = -1) {
  std::ostringstream out;
  out
    << "{\"requestId\":\"" << escape(request_id)
    << "\",\"status\":\"error\",\"errorCode\":\"" << escape(code)
    << "\",\"reason\":\"" << escape(reason)
    << "\",\"writeIssued\":" << (write_issued ? "true" : "false");
  if (operation_before_qpc >= 0) out << ",\"operationBeforeQpcCounter\":\"" << operation_before_qpc << "\"";
  if (operation_after_qpc >= 0) out << ",\"operationAfterQpcCounter\":\"" << operation_after_qpc << "\"";
  out << ",\"targetReset\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return out.str();
}

static bool read_scalar_memory(const HssMemoryIpc& ipc, U32 address, int length, std::vector<unsigned char>* bytes) {
  bool crashed = false;
  U8 status = 0;
  bytes->assign(static_cast<size_t>(length), 0);
  if (length == 1 && ipc.readU8) {
    U8 value = 0;
    const int rc = call_read_mem_u8(ipc.readU8, address, 1U, &value, &status, &crashed);
    if (!crashed && rc >= 0 && status == 0U) {
      (*bytes)[0] = value;
      return true;
    }
  } else if (length == 2 && ipc.readU16) {
    U16 value = 0;
    const int rc = call_read_mem_u16(ipc.readU16, address, 1U, &value, &status, &crashed);
    if (!crashed && rc >= 0 && status == 0U) {
      (*bytes)[0] = static_cast<unsigned char>(value & 0xFFU);
      (*bytes)[1] = static_cast<unsigned char>((value >> 8U) & 0xFFU);
      return true;
    }
  } else if (length == 4 && ipc.readU32) {
    U32 value = 0;
    const int rc = call_read_mem_u32(ipc.readU32, address, 1U, &value, &status, &crashed);
    if (!crashed && rc >= 0 && status == 0U) {
      (*bytes)[0] = static_cast<unsigned char>(value & 0xFFU);
      (*bytes)[1] = static_cast<unsigned char>((value >> 8U) & 0xFFU);
      (*bytes)[2] = static_cast<unsigned char>((value >> 16U) & 0xFFU);
      (*bytes)[3] = static_cast<unsigned char>((value >> 24U) & 0xFFU);
      return true;
    }
  }
  if (!ipc.readMem) return false;
  const int rc = call_read_mem(ipc.readMem, address, static_cast<U32>(length), bytes->data(), &crashed);
  return !crashed && rc >= 0;
}

static bool write_scalar_memory(const HssMemoryIpc& ipc, U32 address, const std::vector<unsigned char>& bytes) {
  bool crashed = false;
  if (bytes.size() == 1U && ipc.writeU8) {
    call_write_u8(ipc.writeU8, address, bytes[0], &crashed);
    if (!crashed) return true;
  } else if (bytes.size() == 2U && ipc.writeU16) {
    const U16 value = static_cast<U16>(bytes[0]) | (static_cast<U16>(bytes[1]) << 8U);
    call_write_u16(ipc.writeU16, address, value, &crashed);
    if (!crashed) return true;
  } else if (bytes.size() == 4U && ipc.writeU32) {
    const U32 value = static_cast<U32>(bytes[0]) | (static_cast<U32>(bytes[1]) << 8U) | (static_cast<U32>(bytes[2]) << 16U) | (static_cast<U32>(bytes[3]) << 24U);
    call_write_u32(ipc.writeU32, address, value, &crashed);
    if (!crashed) return true;
  }
  if (!ipc.writeMem) return false;
  const int rc = call_write_mem(ipc.writeMem, address, static_cast<U32>(bytes.size()), bytes.data(), &crashed);
  return !crashed && rc >= 0;
}

static bool handle_hss_memory_request(const HssMemoryIpc& ipc, bool* target_written) {
  if (ipc.requestFile.empty() || ipc.responseFile.empty()) return false;
  if (GetFileAttributesA(ipc.requestFile.c_str()) == INVALID_FILE_ATTRIBUTES) return false;
  const std::string request = read_text_file_a(ipc.requestFile);
  DeleteFileA(ipc.requestFile.c_str());
  const std::string request_id = json_string(request, "requestId");
  const std::string capture_id = json_string(request, "captureId");
  const std::string op = json_string(request, "op");
  if (request_id.empty() || capture_id != ipc.captureId || (op != "read" && op != "write" && op != "resume")) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_WRITE_REQUEST_INVALID", "memory request is malformed", false));
    return true;
  }
  if (op == "resume") {
    bool crashed = false;
    const int before_halted = ipc.isHalted ? call_int0(ipc.isHalted, &crashed) : -1;
    const int64_t before_qpc = qpc_counter();
    if (crashed || before_halted < 0 || before_qpc < 0 || !ipc.go) {
      write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_CPU_CONTROL_FAILED", "capture-owner resume preflight failed", false));
      return true;
    }
    if (before_halted > 0) call_void0(ipc.go, &crashed);
    const int64_t after_qpc = qpc_counter();
    const int after_halted = call_int0(ipc.isHalted, &crashed);
    if (crashed || after_halted < 0 || after_qpc < before_qpc) {
      write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_CPU_CONTROL_FAILED", "capture-owner resume failed", before_halted > 0));
      return true;
    }
    std::ostringstream out;
    out << "{\"requestId\":\"" << escape(request_id)
        << "\",\"status\":\"ok\",\"op\":\"resume\",\"beforeState\":\"" << (before_halted > 0 ? "halted" : "running")
        << "\",\"afterState\":\"" << (after_halted > 0 ? "halted" : "running")
        << "\",\"operationBeforeQpcCounter\":\"" << before_qpc
        << "\",\"operationAfterQpcCounter\":\"" << after_qpc
        << "\",\"resumeIssued\":" << (before_halted > 0 ? "true" : "false")
        << ",\"targetReset\":false,\"targetWritten\":" << (*target_written ? "true" : "false")
        << ",\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
    write_text_file_a(ipc.responseFile, out.str());
    return true;
  }
  const std::string address_text = json_string(request, "address");
  U32 address = 0;
  int length = json_int(request, "length", 0);
  if (!parse_u32_text(address_text, &address) || length < 1 || length > 4096) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_WRITE_REQUEST_INVALID", "memory request is malformed", false));
    return true;
  }
  if (!ipc.readMem) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "JLINK_READMEM_EXPORT_MISSING", "JLINKARM_ReadMem export missing", false));
    return true;
  }

  if (op == "read") {
    std::vector<unsigned char> bytes;
    if (!read_scalar_memory(ipc, address, length, &bytes)) {
      write_text_file_a(ipc.responseFile, memory_response_error(request_id, "JLINK_READMEM_FAILED", "JLINKARM_ReadMem failed", false));
      return true;
    }
    std::ostringstream out;
    out
      << "{\"requestId\":\"" << escape(request_id)
      << "\",\"status\":\"ok\",\"op\":\"read\",\"address\":\"" << hex_u32(address)
      << "\",\"length\":" << length
      << ",\"bytesHex\":\"" << bytes_hex(bytes)
      << "\",\"targetReset\":false,\"targetWritten\":" << (*target_written ? "true" : "false")
      << ",\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
    write_text_file_a(ipc.responseFile, out.str());
    return true;
  }

  if (!ipc.writeAllowed) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "ARTIFACT_MATCH_UNVERIFIED_WRITE_FORBIDDEN", "unverified Artifact match permits read-only capture only", false));
    return true;
  }
  if (!ipc.writeMem) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "JLINK_WRITEMEM_EXPORT_MISSING", "JLINKARM_WriteMem export missing", false));
    return true;
  }
  std::vector<unsigned char> bytes;
  const std::string bytes_hex_text = json_string(request, "bytesHex");
  const int access_size = json_int(request, "accessSize", 0);
  if ((access_size != 1 && access_size != 2 && access_size != 4) || length % access_size != 0 || !parse_hex_bytes(bytes_hex_text, &bytes) || bytes.size() != static_cast<size_t>(length)) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_WRITE_BYTES_INVALID", "write bytes are malformed", false));
    return true;
  }
  const int64_t operation_before_qpc = qpc_counter();
  if (operation_before_qpc < 0) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_QPC_UNAVAILABLE", "could not timestamp write start", false));
    return true;
  }
  const bool write_ok = write_scalar_memory(ipc, address, bytes);
  const int64_t operation_after_qpc = qpc_counter();
  if (!write_ok) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "JLINK_WRITEMEM_FAILED", "JLINKARM_WriteMem failed", true, operation_before_qpc, operation_after_qpc));
    return true;
  }
  *target_written = true;
  if (operation_after_qpc < operation_before_qpc) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_QPC_UNAVAILABLE", "could not timestamp write completion", true, operation_before_qpc));
    return true;
  }
  std::ostringstream out;
  out
    << "{\"requestId\":\"" << escape(request_id)
    << "\",\"status\":\"ok\",\"op\":\"write\",\"address\":\"" << hex_u32(address)
       << "\",\"length\":" << length
       << ",\"operationBeforeQpcCounter\":\"" << operation_before_qpc
       << "\",\"operationAfterQpcCounter\":\"" << operation_after_qpc << "\""
    << ",\"writeIssued\":true,\"targetReset\":false,\"targetWritten\":true"
    << ",\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  write_text_file_a(ipc.responseFile, out.str());
  return true;
}

static int cpu_control(const std::map<std::wstring, std::wstring>& options, bool state_only) {
  const auto dll_it = options.find(L"--dll");
  const auto script_it = options.find(L"--jlink-script-file");
  const std::wstring dll_path = dll_it == options.end() ? L"" : dll_it->second;
  const std::wstring script_path = script_it == options.end() ? L"" : script_it->second;
  const std::string dll_utf8 = narrow(dll_path);
  const std::string approved_dll_sha256 = option_utf8(options, L"--approved-dll-sha256", "");
  const std::string approved_script_sha256 = option_utf8(options, L"--approved-jlink-script-sha256", "");
  const std::string operation = state_only ? "target-state" : option_utf8(options, L"--operation", "");
  const bool halt_after_reset = option_utf8(options, L"--halt", "false") == "true";
  const std::string device = option_utf8(options, L"--device", "");
  const std::string iface = option_utf8(options, L"--interface", "SWD");
  const std::string serial_text = option_utf8(options, L"--serial", "");
  int speed = 4000;
  if (dll_path.empty() || device.empty() || !valid_sha256_hex(approved_dll_sha256)
      || !parse_int_text(option_utf8(options, L"--speed", "4000"), &speed) || speed < 1
      || (!state_only && operation != "halt" && operation != "resume" && operation != "reset")) {
    error_json("HSS_CPU_CONTROL_PLAN_INVALID", "CPU control requires validated DLL, target, speed, and fixed operation", dll_utf8);
    return 0;
  }
  int64_t timebase_counter = 0;
  int64_t qpc_frequency = 0;
  if (!query_qpc_timebase(&timebase_counter, &qpc_frequency)) {
    error_json("HSS_QPC_UNAVAILABLE", "QueryPerformanceCounter timebase is unavailable", dll_utf8);
    return 0;
  }
  JlinkScriptSelection script_selection;
  std::string script_error_code;
  std::string script_error_reason;
  if (!prepare_jlink_script(option_utf8(options, L"--jlink-script-mode", ""), script_path, approved_script_sha256, &script_selection, &script_error_code, &script_error_reason)) {
    error_json(script_error_code, script_error_reason, dll_utf8);
    return 0;
  }
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }
  std::vector<wchar_t> loaded_path(32768);
  const DWORD loaded_path_bytes = GetModuleFileNameW(dll, loaded_path.data(), static_cast<DWORD>(loaded_path.size()));
  std::string loaded_dll_sha256;
  std::string normalized_approved_sha256 = approved_dll_sha256;
  std::transform(normalized_approved_sha256.begin(), normalized_approved_sha256.end(), normalized_approved_sha256.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (loaded_path_bytes == 0 || loaded_path_bytes >= loaded_path.size()
      || !sha256_file(std::wstring(loaded_path.data(), loaded_path_bytes), &loaded_dll_sha256)
      || loaded_dll_sha256 != normalized_approved_sha256) {
    FreeLibrary(dll);
    error_json("HSS_RUNTIME_IDENTITY_CHANGED", "loaded DLL SHA-256 does not match the approved CPU-control identity", dll_utf8);
    return 0;
  }
  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_halted = reinterpret_cast<JLINKARM_IsHalted_Fn>(required(dll, "JLINKARM_IsHalted"));
  auto arm_halt = reinterpret_cast<JLINKARM_Halt_Fn>(required(dll, "JLINKARM_Halt"));
  auto arm_go = reinterpret_cast<JLINKARM_Go_Fn>(required(dll, "JLINKARM_Go"));
  auto arm_reset = reinterpret_cast<JLINKARM_Reset_Fn>(required(dll, "JLINKARM_Reset"));
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !arm_halted || !arm_version
      || (!state_only && ((operation == "halt" && !arm_halt) || (operation == "resume" && !arm_go)
        || (operation == "reset" && (!arm_reset || (halt_after_reset ? !arm_halt : !arm_go)))))) {
    FreeLibrary(dll);
    error_json("HSS_CPU_CONTROL_EXPORT_MISSING", "required J-Link CPU-control export is missing", dll_utf8);
    return 0;
  }
  bool crashed = false;
  const int dll_version = call_int0(arm_version, &crashed);
  if (crashed || dll_version <= 0) {
    FreeLibrary(dll);
    error_json("HSS_DLL_VERSION_INVALID", "JLINKARM_GetDLLVersion failed", dll_utf8);
    return 0;
  }
  if (!serial_text.empty() && arm_select_sn) (void)call_select_sn(arm_select_sn, static_cast<U32>(std::stoul(serial_text)), &crashed);
  const int open_rc = call_int0(arm_open, &crashed);
  if (crashed || open_rc < 0 || !suppress_jlink_gui(arm_exec, &crashed)) {
    if (open_rc >= 0) call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_OPEN_FAILED", "J-Link CPU-control open failed", dll_utf8);
    return 0;
  }
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  (void)call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  char script_exec_out[512] = {};
  int script_rc = -1;
  if (crashed || !apply_jlink_script(arm_exec, script_selection, &script_rc, script_exec_out, sizeof(script_exec_out), &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json(script_rc != 0 ? "JLINK_SCRIPT_SELECT_FAILED" : "HSS_JLINK_SCRIPT_IDENTITY_CHANGED", "trusted ScriptFile selection failed before CPU control", dll_utf8);
    return 0;
  }
  (void)call_int1(arm_tif, iface == "JTAG" ? 0 : 1, &crashed);
  call_void1(arm_speed, speed, &crashed);
  const int connect_rc = call_int0(arm_connect, &crashed);
  if (crashed || connect_rc < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_CONNECT_FAILED", "J-Link CPU-control connect failed", dll_utf8);
    return 0;
  }
  int64_t operation_before_qpc = state_only ? qpc_counter() : -1;
  const int before_halted = call_int0(arm_halted, &crashed);
  if (crashed || before_halted < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("HSS_CPU_CONTROL_FAILED", "J-Link CPU-control pre-state check failed", dll_utf8);
    return 0;
  }
  bool reset_issued = false;
  bool halt_issued = false;
  bool resume_issued = false;
  if (!state_only) {
    bool control_crashed = false;
    operation_before_qpc = qpc_counter();
    if (operation_before_qpc < 0) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("HSS_QPC_UNAVAILABLE", "could not timestamp CPU-control before hardware action", dll_utf8);
      return 0;
    }
    if (operation == "halt") {
      call_void0(arm_halt, &control_crashed);
      halt_issued = !control_crashed;
    } else if (operation == "resume") {
      call_void0(arm_go, &control_crashed);
      resume_issued = !control_crashed;
    } else {
      call_void0(arm_reset, &control_crashed);
      reset_issued = !control_crashed;
      if (!control_crashed) {
        if (halt_after_reset) {
          call_void0(arm_halt, &control_crashed);
          halt_issued = !control_crashed;
        } else {
          call_void0(arm_go, &control_crashed);
          resume_issued = !control_crashed;
        }
      }
    }
    const int64_t operation_after_control_qpc = qpc_counter();
    if (control_crashed) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("HSS_CPU_CONTROL_FAILED", "J-Link CPU-control export raised a structured exception", dll_utf8);
      return 0;
    }
    if (operation_after_control_qpc < operation_before_qpc) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("HSS_QPC_UNAVAILABLE", "could not timestamp CPU-control after hardware action", dll_utf8);
      return 0;
    }
    timebase_counter = operation_after_control_qpc;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  const int after_halted = call_int0(arm_halted, &crashed);
  const int64_t operation_after_qpc = state_only ? qpc_counter() : timebase_counter;
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);
  if (crashed || after_halted < 0 || operation_before_qpc < 0 || operation_after_qpc < operation_before_qpc) {
    error_json("HSS_CPU_CONTROL_FAILED", "J-Link CPU-control operation or state check failed", dll_utf8);
    return 0;
  }
  std::cout
    << "{\"status\":\"ok\",\"operation\":\"" << operation << "\""
    << ",\"dllVersion\":" << dll_version
    << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
    << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",\"jlinkScriptMode\":\"" << script_selection.mode << "\""
    << ",\"jlinkScriptFile\":\"" << escape(script_selection.pathUtf8) << "\""
    << ",\"jlinkScriptSha256\":\"" << script_selection.sha256 << "\""
    << ",\"jlinkScriptReturnCode\":" << script_rc
    << ",\"qpcFrequency\":\"" << qpc_frequency << "\""
    << ",\"operationBeforeQpcCounter\":\"" << operation_before_qpc << "\""
    << ",\"operationAfterQpcCounter\":\"" << operation_after_qpc << "\""
    << ",\"targetWasHalted\":" << (after_halted > 0 ? "true" : "false")
    << ",\"targetWasHaltedRaw\":" << after_halted
    << ",\"beforeState\":\"" << (before_halted > 0 ? "halted" : "running") << "\""
    << ",\"afterState\":\"" << (after_halted > 0 ? "halted" : "running") << "\""
    << ",\"targetReset\":" << (reset_issued ? "true" : "false")
    << ",\"resetIssued\":" << (reset_issued ? "true" : "false")
    << ",\"haltIssued\":" << (halt_issued ? "true" : "false")
    << ",\"resumeIssued\":" << (resume_issued ? "true" : "false")
    << ",\"targetWritten\":false,\"flashIssued\":false}";
  return 0;
}

static int variable_write(const std::map<std::wstring, std::wstring>& options) {
  const std::wstring dll_path = options.count(L"--dll") ? options.at(L"--dll") : L"";
  const std::wstring script_path = options.count(L"--jlink-script-file") ? options.at(L"--jlink-script-file") : L"";
  const std::wstring manifest_path = options.count(L"--artifact-match-manifest") ? options.at(L"--artifact-match-manifest") : L"";
  const std::wstring plan_path = options.count(L"--plan") ? options.at(L"--plan") : L"";
  const std::string approved_dll_sha256 = option_utf8(options, L"--approved-dll-sha256", "");
  const std::string approved_script_sha256 = option_utf8(options, L"--approved-jlink-script-sha256", "");
  const std::string manifest_sha256 = option_utf8(options, L"--artifact-match-manifest-sha256", "");
  const std::string runtime_sha256 = option_utf8(options, L"--artifact-match-runtime-identity-sha256", "");
  const std::string artifact_generation = option_utf8(options, L"--artifact-generation", "");
  const std::string artifact_sha256 = option_utf8(options, L"--artifact-sha256", "");
  const std::string capture_id = option_utf8(options, L"--capture-id", "");
  const std::string device = option_utf8(options, L"--device", "");
  const std::string iface = option_utf8(options, L"--interface", "SWD");
  const std::string serial_text = option_utf8(options, L"--serial", "");
  const std::string address_text = option_utf8(options, L"--address", "");
  const std::string bytes_hex_text = option_utf8(options, L"--bytes-hex", "");
  int speed = 0;
  int length = 0;
  int access_size = 0;
  U32 address = 0;
  std::vector<unsigned char> requested;
  if (dll_path.empty() || manifest_path.empty() || plan_path.empty() || capture_id.empty() || device.empty() || serial_text.empty()
      || !valid_sha256_hex(approved_dll_sha256) || !valid_sha256_hex(manifest_sha256) || !valid_sha256_hex(runtime_sha256)
      || !valid_sha256_hex(artifact_generation) || !valid_sha256_hex(artifact_sha256)
      || !parse_int_text(option_utf8(options, L"--speed", ""), &speed) || speed < 1
      || !parse_int_text(option_utf8(options, L"--length", ""), &length) || length < 1 || length > 4096
      || !parse_int_text(option_utf8(options, L"--access-size", ""), &access_size) || (access_size != 1 && access_size != 2 && access_size != 4)
      || length % access_size != 0 || !parse_u32_text(address_text, &address)
      || !parse_hex_bytes(bytes_hex_text, &requested) || requested.size() != static_cast<size_t>(length)) {
    error_json("HSS_WRITE_PLAN_INVALID", "variable-write requires exact runtime, target, Artifact, address, bytes, and plan bindings", narrow(dll_path));
    return 0;
  }
  JlinkScriptSelection script_selection;
  std::string script_error_code;
  std::string script_error_reason;
  if (!prepare_jlink_script(option_utf8(options, L"--jlink-script-mode", ""), script_path, approved_script_sha256, &script_selection, &script_error_code, &script_error_reason)) {
    error_json(script_error_code, script_error_reason, narrow(dll_path));
    return 0;
  }
  ArtifactMatchManifest manifest;
  std::string manifest_error_code;
  std::string manifest_error_reason;
  if (!load_artifact_match_manifest(manifest_path, plan_path, manifest_sha256, capture_id, device, serial_text, runtime_sha256, artifact_generation, artifact_sha256, &manifest, &manifest_error_code, &manifest_error_reason)) {
    artifact_match_gate_error(manifest_error_code, manifest_error_reason, capture_id, manifest_sha256);
    return 0;
  }
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  if (!dll) { error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", narrow(dll_path)); return 0; }
  std::vector<wchar_t> loaded_path(32768);
  const DWORD loaded_path_bytes = GetModuleFileNameW(dll, loaded_path.data(), static_cast<DWORD>(loaded_path.size()));
  std::string loaded_dll_sha256;
  std::string normalized_approved = approved_dll_sha256;
  std::transform(normalized_approved.begin(), normalized_approved.end(), normalized_approved.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (loaded_path_bytes == 0 || loaded_path_bytes >= loaded_path.size() || !sha256_file(std::wstring(loaded_path.data(), loaded_path_bytes), &loaded_dll_sha256) || loaded_dll_sha256 != normalized_approved) {
    FreeLibrary(dll); error_json("HSS_RUNTIME_IDENTITY_CHANGED", "loaded DLL SHA-256 does not match the approved write identity", narrow(dll_path)); return 0;
  }
  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  auto arm_read_mem = reinterpret_cast<JLINKARM_ReadMem_Fn>(required(dll, "JLINKARM_ReadMem"));
  auto arm_write_mem = reinterpret_cast<JLINKARM_WriteMem_Fn>(required(dll, "JLINKARM_WriteMem"));
  auto arm_read_u8 = reinterpret_cast<JLINKARM_ReadMemU8_Fn>(required(dll, "JLINKARM_ReadMemU8"));
  auto arm_read_u16 = reinterpret_cast<JLINKARM_ReadMemU16_Fn>(required(dll, "JLINKARM_ReadMemU16"));
  auto arm_read_u32 = reinterpret_cast<JLINKARM_ReadMemU32_Fn>(required(dll, "JLINKARM_ReadMemU32"));
  auto arm_write_u8 = reinterpret_cast<JLINKARM_WriteU8_Fn>(required(dll, "JLINKARM_WriteU8"));
  auto arm_write_u16 = reinterpret_cast<JLINKARM_WriteU16_Fn>(required(dll, "JLINKARM_WriteU16"));
  auto arm_write_u32 = reinterpret_cast<JLINKARM_WriteU32_Fn>(required(dll, "JLINKARM_WriteU32"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !arm_version || !arm_read_mem || !arm_write_mem) {
    FreeLibrary(dll); error_json("HSS_WRITE_EXPORT_MISSING", "required J-Link write export is missing", narrow(dll_path)); return 0;
  }
  bool crashed = false;
  const int dll_version = call_int0(arm_version, &crashed);
  if (!serial_text.empty() && arm_select_sn) (void)call_select_sn(arm_select_sn, static_cast<U32>(std::stoul(serial_text)), &crashed);
  const int open_rc = call_int0(arm_open, &crashed);
  if (crashed || dll_version <= 0 || open_rc < 0 || !suppress_jlink_gui(arm_exec, &crashed)) {
    if (open_rc >= 0) call_void0(arm_close, &crashed); FreeLibrary(dll); error_json("JLINK_OPEN_FAILED", "J-Link variable-write open failed", narrow(dll_path)); return 0;
  }
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  (void)call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  char script_out[512] = {};
  int script_rc = -1;
  if (crashed || !apply_jlink_script(arm_exec, script_selection, &script_rc, script_out, sizeof(script_out), &crashed)) {
    call_void0(arm_close, &crashed); FreeLibrary(dll); error_json("JLINK_SCRIPT_SELECT_FAILED", "trusted ScriptFile selection failed before variable write", narrow(dll_path)); return 0;
  }
  (void)call_int1(arm_tif, iface == "JTAG" ? 0 : 1, &crashed);
  call_void1(arm_speed, speed, &crashed);
  ArtifactMatchConnectionState connection;
  const int connect_rc = call_int0(arm_connect, &crashed);
  const uint64_t connect_ordinal = connection.connected();
  if (crashed || connect_rc < 0 || connect_ordinal != manifest.connectOrdinal) {
    call_void0(arm_close, &crashed); FreeLibrary(dll); artifact_match_gate_error("ARTIFACT_MATCH_BINDING_MISMATCH", "variable-write connection does not match the plan", capture_id, manifest_sha256); return 0;
  }
  ArtifactMatchResult match = compare_artifact_ranges(manifest, [&](U32 read_address, U32 count, U8* data, std::string* reason) {
    bool read_crashed = false;
    const int rc = call_read_mem(arm_read_mem, read_address, count, data, &read_crashed);
    if (read_crashed || rc < 0) { *reason = "JLINKARM_ReadMem failed the nonvolatile read"; return false; }
    return true;
  });
  if (match.status == ArtifactMatchStatus::verified) connection.recordVerified(connect_ordinal);
  if (match.status != ArtifactMatchStatus::verified || !connection.consumeVerified(connect_ordinal)) {
    call_void0(arm_close, &crashed); FreeLibrary(dll);
    const std::string code = match.gateErrorCode.empty() ? "ARTIFACT_MATCH_UNVERIFIED_WRITE_FORBIDDEN" : match.gateErrorCode;
    artifact_match_gate_error(code, match.reason, capture_id, manifest_sha256, &manifest, &match);
    return 0;
  }
  HssMemoryIpc ipc{"", "", capture_id, arm_read_mem, arm_write_mem, arm_read_u8, arm_read_u16, arm_read_u32, arm_write_u8, arm_write_u16, arm_write_u32, nullptr, nullptr, true};
  std::vector<unsigned char> old_bytes;
  std::vector<unsigned char> readback_bytes;
  if (!read_scalar_memory(ipc, address, length, &old_bytes)) {
    call_void0(arm_close, &crashed); FreeLibrary(dll); artifact_match_gate_error("JLINK_READMEM_FAILED", "old-value read failed before variable write", capture_id, manifest_sha256, &manifest, &match); return 0;
  }
  const int64_t before_qpc = qpc_counter();
  const bool write_ok = before_qpc >= 0 && write_scalar_memory(ipc, address, requested);
  const int64_t after_qpc = qpc_counter();
  const bool readback_ok = read_scalar_memory(ipc, address, length, &readback_bytes);
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);
  if (!write_ok || after_qpc < before_qpc || !readback_ok) {
    std::cout << "{\"status\":\"error\",\"errorCode\":\"" << (!write_ok ? "JLINK_WRITEMEM_FAILED" : !readback_ok ? "READBACK_FAILED" : "HSS_QPC_UNAVAILABLE")
              << "\",\"reason\":\"variable write or readback failed\",\"writeIssued\":" << (write_ok ? "true" : "false");
    write_artifact_match_evidence(manifest, manifest_sha256, match);
    std::cout << ",\"targetWritten\":" << (write_ok ? "true" : "false") << ",\"targetReset\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
    return 0;
  }
  std::cout << "{\"status\":\"ok\",\"command\":\"variable-write\",\"dllVersion\":" << dll_version
            << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
            << ",\"jlinkScriptMode\":\"" << script_selection.mode << "\",\"jlinkScriptFile\":\"" << escape(script_selection.pathUtf8)
            << "\",\"jlinkScriptSha256\":\"" << script_selection.sha256 << "\",\"jlinkScriptReturnCode\":" << script_rc
            << ",\"oldBytesHex\":\"" << bytes_hex(old_bytes) << "\",\"readbackBytesHex\":\"" << bytes_hex(readback_bytes)
            << "\",\"operationBeforeQpcCounter\":\"" << before_qpc << "\",\"operationAfterQpcCounter\":\"" << after_qpc << "\",\"writeIssued\":true";
  write_artifact_match_evidence(manifest, manifest_sha256, match);
  std::cout << ",\"targetWritten\":true,\"targetReset\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return 0;
}

static bool exact_r4_option_set(int argc, wchar_t** argv, const std::map<std::wstring, std::wstring>& options, std::string* reason) {
  if (argc < 2 || (argc - 2) % 2 != 0 || options.size() != static_cast<size_t>((argc - 2) / 2)) {
    *reason = "variable-write-r4 arguments must be unique name/value pairs";
    return false;
  }
  std::set<std::wstring> expected{
    L"--dll", L"--approved-dll-sha256", L"--device", L"--interface", L"--speed", L"--serial",
    L"--jlink-script-mode", L"--capture-id", L"--plan", L"--r4-exception-summary-sha256",
    L"--artifact-match-manifest", L"--artifact-match-manifest-sha256", L"--artifact-match-runtime-identity-sha256",
    L"--artifact-generation", L"--artifact-sha256", L"--address", L"--length", L"--access-size", L"--bytes-hex",
  };
  const std::string mode = option_utf8(options, L"--jlink-script-mode", "");
  if (mode == "file") {
    expected.insert(L"--jlink-script-file");
    expected.insert(L"--approved-jlink-script-sha256");
  } else if (mode != "none") {
    *reason = "variable-write-r4 requires script mode none or file";
    return false;
  }
  std::set<std::wstring> actual;
  for (const auto& [key, unused] : options) { (void)unused; actual.insert(key); }
  if (actual != expected) {
    *reason = "variable-write-r4 contains missing or unknown helper arguments";
    return false;
  }
  return true;
}

static void r4_write_error(
    const std::string& code,
    const std::string& reason,
    const std::string& summary,
    bool exception_consumed,
    bool write_issued,
    const ArtifactMatchManifest* manifest = nullptr,
    const std::string& manifest_sha256 = "",
    const ArtifactMatchResult* match = nullptr,
    const std::vector<unsigned char>* old_bytes = nullptr,
    const std::vector<unsigned char>* readback_bytes = nullptr,
    int64_t before_qpc = -1,
    int64_t after_qpc = -1) {
  std::cout << "{\"status\":\"error\",\"command\":\"variable-write-r4\",\"errorCode\":" << canonical_json_string(code)
            << ",\"reason\":" << canonical_json_string(reason)
            << ",\"r4ExceptionConsumed\":" << (exception_consumed ? "true" : "false")
            << ",\"r4ExceptionSummarySha256\":" << canonical_json_string(summary)
            << ",\"writeIssued\":" << (write_issued ? "true" : "false");
  if (old_bytes) std::cout << ",\"oldBytesHex\":\"" << bytes_hex(*old_bytes) << "\"";
  if (readback_bytes) std::cout << ",\"readbackBytesHex\":\"" << bytes_hex(*readback_bytes) << "\"";
  if (before_qpc >= 0) std::cout << ",\"operationBeforeQpcCounter\":\"" << before_qpc << "\"";
  if (after_qpc >= 0) std::cout << ",\"operationAfterQpcCounter\":\"" << after_qpc << "\"";
  if (manifest && match) write_artifact_match_evidence(*manifest, manifest_sha256, *match);
  std::cout << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
            << ",\"targetWritten\":" << (write_issued ? "true" : "false")
            << ",\"targetReset\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
}

static int variable_write_r4(int argc, wchar_t** argv, const std::map<std::wstring, std::wstring>& options) {
  std::string reason;
  if (!exact_r4_option_set(argc, argv, options, &reason)) {
    r4_write_error("HSS_R4_NATIVE_EXCEPTION_INVALID", reason, option_utf8(options, L"--r4-exception-summary-sha256", ""), false, false);
    return 0;
  }
  const std::wstring dll_path = options.at(L"--dll");
  const std::wstring plan_path = options.at(L"--plan");
  const std::wstring manifest_path = options.at(L"--artifact-match-manifest");
  const std::wstring script_path = options.count(L"--jlink-script-file") ? options.at(L"--jlink-script-file") : L"";
  const std::string approved_dll_sha256 = option_utf8(options, L"--approved-dll-sha256", "");
  const std::string approved_script_sha256 = option_utf8(options, L"--approved-jlink-script-sha256", "");
  const std::string manifest_sha256 = option_utf8(options, L"--artifact-match-manifest-sha256", "");
  const std::string runtime_sha256 = option_utf8(options, L"--artifact-match-runtime-identity-sha256", "");
  const std::string artifact_generation = option_utf8(options, L"--artifact-generation", "");
  const std::string artifact_sha256 = option_utf8(options, L"--artifact-sha256", "");
  const std::string summary_sha256 = option_utf8(options, L"--r4-exception-summary-sha256", "");
  const std::string capture_id = option_utf8(options, L"--capture-id", "");
  const std::string device = option_utf8(options, L"--device", "");
  const std::string iface = option_utf8(options, L"--interface", "");
  const std::string serial_text = option_utf8(options, L"--serial", "");
  const std::string address_text = option_utf8(options, L"--address", "");
  const std::string bytes_hex_text = option_utf8(options, L"--bytes-hex", "");
  int speed = 0;
  int length = 0;
  int access_size = 0;
  U32 serial = 0;
  if (dll_path.empty() || plan_path.empty() || manifest_path.empty() || capture_id.empty() || device.empty() || serial_text.empty()
      || !lower_sha256(approved_dll_sha256) || !lower_sha256(manifest_sha256) || !lower_sha256(runtime_sha256)
      || !lower_sha256(artifact_generation) || !lower_sha256(artifact_sha256) || !lower_sha256(summary_sha256)
      || (option_utf8(options, L"--jlink-script-mode", "") == "file" && !lower_sha256(approved_script_sha256))
      || !parse_int_text(option_utf8(options, L"--speed", ""), &speed) || speed < 1
      || !parse_int_text(option_utf8(options, L"--length", ""), &length) || length < 1 || length > 4096
      || !parse_int_text(option_utf8(options, L"--access-size", ""), &access_size) || (access_size != 1 && access_size != 2 && access_size != 4)
      || !parse_u32_text(serial_text, &serial)) {
    r4_write_error("HSS_R4_NATIVE_EXCEPTION_INVALID", "variable-write-r4 requires exact canonical helper bindings", summary_sha256, false, false);
    return 0;
  }
  std::string envelope_bytes;
  if (!read_bounded_text_file(plan_path, 64U * 1024U, &envelope_bytes)) {
    r4_write_error("HSS_R4_NATIVE_EXCEPTION_READ_FAILED", "R4 exception envelope is missing, empty, or exceeds its byte bound", summary_sha256, false, false);
    return 0;
  }
  const R4CommandBindings expected{
    narrow(plan_path), summary_sha256, device, iface, serial_text, speed, capture_id, runtime_sha256,
    artifact_generation, artifact_sha256, address_text, length, access_size, bytes_hex_text, true,
  };
  R4NativeException exception;
  if (!validate_r4_native_exception(envelope_bytes, expected, &exception, &reason)) {
    r4_write_error("HSS_R4_NATIVE_EXCEPTION_INVALID", reason, summary_sha256, false, false);
    return 0;
  }
  std::vector<unsigned char> requested;
  if (!parse_hex_bytes(bytes_hex_text, &requested) || requested.size() != static_cast<size_t>(length)) {
    r4_write_error("HSS_R4_NATIVE_EXCEPTION_INVALID", "R4 write bytes do not match the validated envelope", summary_sha256, false, false);
    return 0;
  }
  JlinkScriptSelection script_selection;
  std::string script_error_code;
  std::string script_error_reason;
  if (!prepare_jlink_script(option_utf8(options, L"--jlink-script-mode", ""), script_path, approved_script_sha256, &script_selection, &script_error_code, &script_error_reason)) {
    r4_write_error(script_error_code, script_error_reason, summary_sha256, true, false);
    return 0;
  }
  ArtifactMatchManifest manifest;
  std::string manifest_error_code;
  if (!load_artifact_match_manifest(manifest_path, plan_path, manifest_sha256, capture_id, device, serial_text, runtime_sha256, artifact_generation, artifact_sha256, &manifest, &manifest_error_code, &reason)) {
    r4_write_error(manifest_error_code, reason, summary_sha256, true, false);
    return 0;
  }
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  if (!dll) { r4_write_error("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", summary_sha256, true, false); return 0; }
  std::vector<wchar_t> loaded_path(32768);
  const DWORD loaded_path_bytes = GetModuleFileNameW(dll, loaded_path.data(), static_cast<DWORD>(loaded_path.size()));
  std::string loaded_dll_sha256;
  if (loaded_path_bytes == 0 || loaded_path_bytes >= loaded_path.size()
      || !sha256_file(std::wstring(loaded_path.data(), loaded_path_bytes), &loaded_dll_sha256) || loaded_dll_sha256 != approved_dll_sha256) {
    FreeLibrary(dll); r4_write_error("HSS_RUNTIME_IDENTITY_CHANGED", "loaded DLL SHA-256 does not match the R4 runtime binding", summary_sha256, true, false); return 0;
  }
  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_get_sn = reinterpret_cast<JLINKARM_GetSN_Fn>(required(dll, "JLINKARM_GetSN"));
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  auto arm_read_u8 = reinterpret_cast<JLINKARM_ReadMemU8_Fn>(required(dll, "JLINKARM_ReadMemU8"));
  auto arm_write_mem = reinterpret_cast<JLINKARM_WriteMem_Fn>(required(dll, "JLINKARM_WriteMem"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !arm_select_sn || !arm_get_sn || !arm_version || !arm_read_u8 || !arm_write_mem) {
    FreeLibrary(dll); r4_write_error("HSS_WRITE_EXPORT_MISSING", "required same-connection R4 write export is missing", summary_sha256, true, false); return 0;
  }
  bool crashed = false;
  const int dll_version = call_int0(arm_version, &crashed);
  const int select_rc = call_select_sn(arm_select_sn, serial, &crashed);
  const int open_rc = crashed ? -1 : call_int0(arm_open, &crashed);
  if (crashed || dll_version <= 0 || select_rc < 0 || open_rc < 0 || !suppress_jlink_gui(arm_exec, &crashed)) {
    if (open_rc >= 0) call_void0(arm_close, &crashed);
    FreeLibrary(dll); r4_write_error("JLINK_OPEN_FAILED", "J-Link R4 variable-write open failed", summary_sha256, true, false); return 0;
  }
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  const int device_rc = call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  char script_out[512] = {};
  int script_rc = -1;
  if (crashed || device_rc < 0 || !apply_jlink_script(arm_exec, script_selection, &script_rc, script_out, sizeof(script_out), &crashed)) {
    call_void0(arm_close, &crashed); FreeLibrary(dll); r4_write_error("JLINK_SCRIPT_SELECT_FAILED", "trusted ScriptFile selection failed before R4 variable write", summary_sha256, true, false); return 0;
  }
  const int tif_rc = call_int1(arm_tif, iface == "JTAG" ? 0 : 1, &crashed);
  call_void1(arm_speed, speed, &crashed);
  ArtifactMatchConnectionState connection;
  const int connect_rc = crashed ? -1 : call_int0(arm_connect, &crashed);
  const uint64_t connect_ordinal = connection.connected();
  const U32 connected_serial = crashed ? 0U : call_u320(arm_get_sn, &crashed);
  if (crashed || tif_rc < 0 || connect_rc < 0 || connected_serial != serial || connect_ordinal != manifest.connectOrdinal) {
    call_void0(arm_close, &crashed); FreeLibrary(dll); r4_write_error("ARTIFACT_MATCH_BINDING_MISMATCH", "R4 physical connection does not match the envelope", summary_sha256, true, false); return 0;
  }
  bool artifact_read_crashed = false;
  ArtifactMatchResult match = compare_artifact_ranges(manifest, [&](U32 read_address, U32 count, U8* data, std::string* read_reason) {
    std::vector<U8> status(count, 0xFFU);
    bool read_crashed = false;
    const int rc = call_read_mem_u8(arm_read_u8, read_address, count, data, status.data(), &read_crashed);
    artifact_read_crashed = artifact_read_crashed || read_crashed;
    if (read_crashed || rc < 0 || std::any_of(status.begin(), status.end(), [](U8 value) { return value != 0U; })) {
      *read_reason = "JLINKARM_ReadMemU8 returned a failed or partial nonvolatile read";
      return false;
    }
    return true;
  });
  if (artifact_read_crashed || match.status != ArtifactMatchStatus::unverified) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    const std::string code = match.status == ArtifactMatchStatus::mismatch ? "ARTIFACT_MATCH_MISMATCH"
      : match.status == ArtifactMatchStatus::verified ? "HSS_R4_ARTIFACT_STATE_INVALID" : "ARTIFACT_MATCH_READ_INCOMPLETE";
    const std::string state_reason = match.status == ArtifactMatchStatus::verified
      ? "verified targets must use the approval-free R2 variable-write path"
      : match.status == ArtifactMatchStatus::mismatch ? "target Artifact mismatch is never writable"
        : "Artifact comparison raised an exception; the connection is not safe for an R4 write";
    r4_write_error(code, state_reason, summary_sha256, true, false, &manifest, manifest_sha256, &match);
    return 0;
  }
  const auto exact_read = [&](U32 read_address, int read_length, std::vector<unsigned char>* bytes) {
    bytes->assign(static_cast<size_t>(read_length), 0U);
    std::vector<U8> status(static_cast<size_t>(read_length), 0xFFU);
    bool read_crashed = false;
    const int rc = call_read_mem_u8(arm_read_u8, read_address, static_cast<U32>(read_length), bytes->data(), status.data(), &read_crashed);
    return !read_crashed && rc >= 0 && std::all_of(status.begin(), status.end(), [](U8 value) { return value == 0U; });
  };
  const auto write_once = [&](U32 write_address, const std::vector<unsigned char>& bytes) {
    bool write_crashed = false;
    const int rc = call_write_mem(arm_write_mem, write_address, static_cast<U32>(bytes.size()), bytes.data(), &write_crashed);
    return !write_crashed && rc >= 0;
  };
  const int64_t before_qpc = qpc_counter();
  if (before_qpc < 0) {
    call_void0(arm_close, &crashed); FreeLibrary(dll); r4_write_error("HSS_QPC_UNAVAILABLE", "could not timestamp R4 variable write", summary_sha256, true, false, &manifest, manifest_sha256, &match); return 0;
  }
  R4MemoryTransactionResult transaction = execute_r4_memory_transaction(match.status, exception.address, requested, exact_read, write_once);
  const int64_t after_qpc = qpc_counter();
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);
  if (!transaction.ok || after_qpc < before_qpc) {
    const std::string code = transaction.ok ? "HSS_QPC_UNAVAILABLE" : transaction.errorCode;
    const std::string failure = transaction.ok ? "could not timestamp R4 variable write completion"
      : transaction.errorCode == "JLINK_READMEM_FAILED" ? "old-value read failed before R4 variable write"
      : transaction.errorCode == "JLINK_WRITEMEM_FAILED" ? "R4 variable write failed; target state is unknown"
      : transaction.errorCode == "READBACK_FAILED" ? "R4 readback failed after write; target state is unknown"
      : transaction.errorCode == "READBACK_MISMATCH" ? "R4 readback does not match the requested bytes"
      : "R4 variable-write transaction failed";
    r4_write_error(code, failure, summary_sha256, true, transaction.writeIssued, &manifest, manifest_sha256, &match,
      transaction.oldBytes.empty() ? nullptr : &transaction.oldBytes,
      transaction.readbackBytes.empty() ? nullptr : &transaction.readbackBytes, before_qpc, after_qpc);
    return 0;
  }
  std::cout << "{\"status\":\"ok\",\"command\":\"variable-write-r4\",\"dllVersion\":" << dll_version
            << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
            << ",\"jlinkScriptMode\":\"" << script_selection.mode << "\",\"jlinkScriptFile\":\"" << escape(script_selection.pathUtf8)
            << "\",\"jlinkScriptSha256\":\"" << script_selection.sha256 << "\",\"jlinkScriptReturnCode\":" << script_rc
            << ",\"r4ExceptionConsumed\":true,\"r4ExceptionSummarySha256\":\"" << summary_sha256
            << "\",\"oldBytesHex\":\"" << bytes_hex(transaction.oldBytes) << "\",\"readbackBytesHex\":\"" << bytes_hex(transaction.readbackBytes)
            << "\",\"operationBeforeQpcCounter\":\"" << before_qpc << "\",\"operationAfterQpcCounter\":\"" << after_qpc << "\",\"writeIssued\":true";
  write_artifact_match_evidence(manifest, manifest_sha256, match);
  std::cout << ",\"targetWritten\":true,\"targetReset\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return 0;
}

static int hss_capture(const std::map<std::wstring, std::wstring>& options) {
  const auto plan_it = options.find(L"--plan");
  if (plan_it == options.end()) {
    error_json("HSS_PLAN_MISSING", "--plan is required");
    return 0;
  }
  const std::string plan = read_text_file(plan_it->second);
  if (plan.empty()) {
    error_json("HSS_PLAN_READ_FAILED", "plan file could not be read");
    return 0;
  }
  const std::string dll_utf8 = json_string(plan, "dllPath");
  const std::string approved_dll_sha256 = json_string(plan, "approvedDllSha256");
  const std::string jlink_script_utf8 = json_string(plan, "jlinkScriptFile");
  const std::string approved_jlink_script_sha256 = json_string(plan, "approvedJlinkScriptSha256");
  const std::string artifact_match_manifest_utf8 = json_string(plan, "artifactMatchManifestPath");
  const std::string artifact_match_manifest_sha256 = json_string(plan, "artifactMatchManifestSha256");
  const std::string artifact_match_runtime_identity_sha256 = json_string(plan, "artifactMatchRuntimeIdentitySha256");
  const std::string artifact_generation = json_string(plan, "artifactGeneration");
  const std::string artifact_sha256 = json_string(plan, "artifactSha256");
  const std::string jlink_script_mode = option_utf8(options, L"--jlink-script-mode", "");
  const bool runtime_identity_validated = json_bool(plan, "runtimeIdentityValidated", false);
  const std::string output_file = json_string(plan, "outputFile");
  const std::string stop_file = json_string(plan, "stopFile");
  const std::string write_request_file = json_string(plan, "writeRequestFile");
  const std::string write_response_file = json_string(plan, "writeResponseFile");
  const std::string capture_id = json_string(plan, "captureId");
  const std::string qpc_epoch_text = json_string(plan, "qpcEpochCounter");
  const std::string qpc_frequency_text = json_string(plan, "qpcFrequency");
  const std::string device = json_string(plan, "device", "");
  const std::string iface = json_string(plan, "interface", "SWD");
  const std::string serial_text = json_string(plan, "serial");
  const std::string read_mode = json_string(plan, "readMode", "periodic");
  const bool resume_before_start = json_bool(plan, "resumeBeforeStart", false);
  const bool require_first_sample_index_zero = json_bool(plan, "requireFirstSampleIndexZero", false);
  const int speed = json_int(plan, "speedKhz", 4000);
  const int requested_rate = json_int(plan, "requestedRateHz", 1000);
  const int duration_sec = json_int(plan, "durationSec", 1);
  const std::string post_connect_counter_address_text = json_string(plan, "postConnectCounterAddress");
  const std::string post_connect_counter_type = json_string(plan, "postConnectCounterType");
  const std::string post_connect_counter_modulus = json_string(plan, "postConnectCounterModulus");
  const int post_connect_expected_rate_hz = json_int(plan, "postConnectExpectedRateHz", 0);
  const double post_connect_rate_tolerance_ratio = json_double(plan, "postConnectRateToleranceRatio", -1.0);
  const int post_connect_minimum_recovery_ms = json_int(plan, "postConnectMinimumRecoveryMs", -1);
  const int post_connect_timeout_ms = json_int(plan, "postConnectTimeoutMs", -1);
  const int post_connect_poll_interval_ms = json_int(plan, "postConnectPollIntervalMs", -1);
  const int post_connect_required_checks = json_int(plan, "postConnectRequiredConsecutiveRunningChecks", -1);
  const bool post_connect_stability_required = json_bool(plan, "postConnectStabilityRequired", false);
  U32 post_connect_counter_address = 0;
  const auto symbols = json_symbols(plan);
  uint64_t requested_samples = 0;
  int64_t qpc_epoch = 0;
  int64_t planned_qpc_frequency = 0;
  std::wstring output_path;
  const std::regex uuid("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}");
  if (dll_utf8.empty() || output_file.empty() || !std::regex_match(capture_id, uuid) || symbols.size() > 10
      || !valid_jcap_symbols(symbols) || !capture_sample_budget(requested_rate, duration_sec, &requested_samples)
      || !valid_jcap_samples_path(output_file, capture_id, &output_path)) {
    error_json("HSS_PLAN_INVALID", "plan is missing required fields");
    return 0;
  }
  if (!parse_qpc_decimal(qpc_epoch_text, &qpc_epoch) || !parse_qpc_decimal(qpc_frequency_text, &planned_qpc_frequency)
      || planned_qpc_frequency <= 0) {
    error_json("HSS_QPC_TIMEBASE_INVALID", "capture plan requires decimal pre-reset qpcEpochCounter and qpcFrequency");
    return 0;
  }
  if (device.empty() || device == "Unspecified") {
    error_json("HSS_DEVICE_REQUIRED", "HSS capture requires an explicit concrete J-Link target device");
    return 0;
  }
  if (read_mode != "periodic" && read_mode != "drain") {
    error_json("HSS_PLAN_INVALID", "readMode must be periodic or drain");
    return 0;
  }
  if (post_connect_stability_required && (!parse_u32_text(post_connect_counter_address_text, &post_connect_counter_address)
      || post_connect_counter_type != "uint32"
      || post_connect_counter_modulus != "4294967296"
      || post_connect_expected_rate_hz < 1 || post_connect_expected_rate_hz > 1000000
      || post_connect_rate_tolerance_ratio <= 0.0 || post_connect_rate_tolerance_ratio >= 1.0
      || post_connect_minimum_recovery_ms < 0 || post_connect_minimum_recovery_ms > 60000
      || post_connect_timeout_ms < 1 || post_connect_timeout_ms > 60000
      || post_connect_poll_interval_ms < 10 || post_connect_poll_interval_ms > 1000
      || post_connect_required_checks < 2 || post_connect_required_checks > 100)) {
    error_json("HSS_PLAN_INVALID", "post-connect uint32 counter stability policy is missing or invalid");
    return 0;
  }
  if (!runtime_identity_validated || !valid_sha256_hex(approved_dll_sha256)) {
    error_json("HSS_RUNTIME_IDENTITY_UNVALIDATED", "capture plan requires a validated DLL SHA-256 identity", dll_utf8);
    return 0;
  }
  if (artifact_match_manifest_utf8.empty() || !valid_sha256_hex(artifact_match_manifest_sha256)
      || !valid_sha256_hex(artifact_match_runtime_identity_sha256) || !valid_sha256_hex(artifact_generation)
      || !valid_sha256_hex(artifact_sha256) || serial_text.empty()) {
    artifact_match_gate_error("ARTIFACT_MATCH_PLAN_INVALID", "capture plan requires manifest, runtime, Artifact generation, Artifact hash, and probe bindings", capture_id, artifact_match_manifest_sha256);
    return 0;
  }
  JlinkScriptSelection script_selection;
  std::string script_error_code;
  std::string script_error_reason;
  std::wstring jlink_script_path;
  if (!jlink_script_utf8.empty() && !widen_utf8(jlink_script_utf8, &jlink_script_path)) {
    error_json("HSS_JLINK_SCRIPT_PATH_INVALID", "J-Link script path is not valid lossless UTF-8", dll_utf8);
    return 0;
  }
  if (!prepare_jlink_script(
      jlink_script_mode,
      jlink_script_path,
      approved_jlink_script_sha256,
      &script_selection,
      &script_error_code,
      &script_error_reason)) {
    error_json(script_error_code, script_error_reason, dll_utf8);
    return 0;
  }

  int64_t current_qpc = 0;
  int64_t actual_qpc_frequency = 0;
  if (!query_qpc_timebase(&current_qpc, &actual_qpc_frequency)) {
    error_json("HSS_QPC_UNAVAILABLE", "QueryPerformanceCounter timebase is unavailable", dll_utf8);
    return 0;
  }
  if (planned_qpc_frequency != actual_qpc_frequency || qpc_epoch > current_qpc) {
    error_json("HSS_QPC_TIMEBASE_INVALID", "capture QPC epoch is future-dated or its frequency does not match this host", dll_utf8);
    return 0;
  }
  stream_lifecycle(capture_id, "qpc_epoch", current_qpc,
    ",\"qpcEpochCounter\":\"" + std::to_string(qpc_epoch) + "\",\"qpcFrequency\":\"" + std::to_string(actual_qpc_frequency) + "\"");
  std::wstring artifact_match_manifest_path;
  if (!widen_utf8(artifact_match_manifest_utf8, &artifact_match_manifest_path)) {
    artifact_match_gate_error("ARTIFACT_MATCH_MANIFEST_PATH_INVALID", "artifact match manifest path is not valid lossless UTF-8", capture_id, artifact_match_manifest_sha256, nullptr, nullptr, qpc_epoch, actual_qpc_frequency);
    return 0;
  }
  ArtifactMatchManifest artifact_match_manifest;
  std::string artifact_match_error_code;
  std::string artifact_match_error_reason;
  if (!load_artifact_match_manifest(
      artifact_match_manifest_path,
      plan_it->second,
      artifact_match_manifest_sha256,
      capture_id,
      device,
      serial_text,
      artifact_match_runtime_identity_sha256,
      artifact_generation,
      artifact_sha256,
      &artifact_match_manifest,
      &artifact_match_error_code,
      &artifact_match_error_reason)) {
    artifact_match_gate_error(artifact_match_error_code, artifact_match_error_reason, capture_id, artifact_match_manifest_sha256, nullptr, nullptr, qpc_epoch, actual_qpc_frequency);
    return 0;
  }
  JcapSampleWriter raw_writer;

  std::wstring dll_path;
  if (!widen_utf8(dll_utf8, &dll_path)) {
    error_json("HSS_DLL_PATH_INVALID", "DLL path is not valid lossless UTF-8", dll_utf8);
    return 0;
  }
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }
  std::vector<wchar_t> loaded_path(32768);
  const DWORD loaded_path_bytes = GetModuleFileNameW(dll, loaded_path.data(), static_cast<DWORD>(loaded_path.size()));
  std::string loaded_dll_sha256;
  std::string normalized_approved_sha256 = approved_dll_sha256;
  std::transform(normalized_approved_sha256.begin(), normalized_approved_sha256.end(), normalized_approved_sha256.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
  if (loaded_path_bytes == 0 || loaded_path_bytes >= loaded_path.size()
      || !sha256_file(std::wstring(loaded_path.data(), loaded_path_bytes), &loaded_dll_sha256)
      || loaded_dll_sha256 != normalized_approved_sha256) {
    FreeLibrary(dll);
    error_json("HSS_RUNTIME_IDENTITY_CHANGED", "loaded DLL SHA-256 does not match the approved capture identity", dll_utf8);
    return 0;
  }
  auto arm_open = reinterpret_cast<JLINKARM_Open_Fn>(required(dll, "JLINKARM_Open"));
  auto arm_close = reinterpret_cast<JLINKARM_Close_Fn>(required(dll, "JLINKARM_Close"));
  auto arm_exec = reinterpret_cast<JLINKARM_ExecCommand_Fn>(required(dll, "JLINKARM_ExecCommand"));
  auto arm_tif = reinterpret_cast<JLINKARM_TIF_Select_Fn>(required(dll, "JLINKARM_TIF_Select"));
  auto arm_speed = reinterpret_cast<JLINKARM_SetSpeed_Fn>(required(dll, "JLINKARM_SetSpeed"));
  auto arm_connect = reinterpret_cast<JLINKARM_Connect_Fn>(required(dll, "JLINKARM_Connect"));
  auto arm_select_sn = reinterpret_cast<JLINKARM_EMU_SelectByUSBSN_Fn>(required(dll, "JLINKARM_EMU_SelectByUSBSN"));
  auto arm_halted = reinterpret_cast<JLINKARM_IsHalted_Fn>(required(dll, "JLINKARM_IsHalted"));
  auto arm_go = reinterpret_cast<JLINKARM_Go_Fn>(required(dll, "JLINKARM_Go"));
  auto arm_read_mem = reinterpret_cast<JLINKARM_ReadMem_Fn>(required(dll, "JLINKARM_ReadMem"));
  auto arm_write_mem = reinterpret_cast<JLINKARM_WriteMem_Fn>(required(dll, "JLINKARM_WriteMem"));
  auto arm_read_u8 = reinterpret_cast<JLINKARM_ReadMemU8_Fn>(required(dll, "JLINKARM_ReadMemU8"));
  auto arm_read_u16 = reinterpret_cast<JLINKARM_ReadMemU16_Fn>(required(dll, "JLINKARM_ReadMemU16"));
  auto arm_read_u32 = reinterpret_cast<JLINKARM_ReadMemU32_Fn>(required(dll, "JLINKARM_ReadMemU32"));
  auto arm_write_u8 = reinterpret_cast<JLINKARM_WriteU8_Fn>(required(dll, "JLINKARM_WriteU8"));
  auto arm_write_u16 = reinterpret_cast<JLINKARM_WriteU16_Fn>(required(dll, "JLINKARM_WriteU16"));
  auto arm_write_u32 = reinterpret_cast<JLINKARM_WriteU32_Fn>(required(dll, "JLINKARM_WriteU32"));
  auto arm_version = reinterpret_cast<JLINKARM_GetDLLVersion_Fn>(required(dll, "JLINKARM_GetDLLVersion"));
  auto hss_start = reinterpret_cast<JLINK_HSS_Start_Fn>(required(dll, "JLINK_HSS_Start"));
  auto hss_read = reinterpret_cast<JLINK_HSS_Read_Fn>(required(dll, "JLINK_HSS_Read"));
  auto hss_stop = reinterpret_cast<JLINK_HSS_Stop_Fn>(required(dll, "JLINK_HSS_Stop"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !arm_halted || !arm_read_mem || !arm_read_u32 || !arm_version || !hss_start || !hss_read || !hss_stop) {
    FreeLibrary(dll);
    error_json("HSS_EXPORT_MISSING", "required JLINKARM/JLINK_HSS exports missing", dll_utf8);
    return 0;
  }

  bool crashed = false;
  const int dll_version = call_int0(arm_version, &crashed);
  if (crashed || dll_version <= 0) {
    FreeLibrary(dll);
    error_json("HSS_DLL_VERSION_INVALID", "JLINKARM_GetDLLVersion failed", dll_utf8);
    return 0;
  }
  if (!serial_text.empty() && arm_select_sn) {
    (void)call_select_sn(arm_select_sn, static_cast<U32>(std::stoul(serial_text)), &crashed);
    if (crashed) {
      FreeLibrary(dll);
      error_json("JLINK_SELECT_SN_EXCEPTION", "JLINKARM_EMU_SelectByUSBSN raised a structured exception", dll_utf8);
      return 0;
    }
  }
  int open_rc = call_int0(arm_open, &crashed);
  if (crashed || open_rc < 0) {
    FreeLibrary(dll);
    error_json("JLINK_OPEN_FAILED", "JLINKARM_Open failed", dll_utf8);
    return 0;
  }
  if (!suppress_jlink_gui(arm_exec, &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_SUPPRESS_GUI_EXCEPTION", "JLINKARM_ExecCommand(SuppressGUI) raised a structured exception", dll_utf8);
    return 0;
  }
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  (void)call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_EXEC_DEVICE_EXCEPTION", "JLINKARM_ExecCommand(device) raised a structured exception", dll_utf8);
    return 0;
  }
  char script_exec_out[512] = {};
  int script_rc = 0;
  if (!apply_jlink_script(arm_exec, script_selection, &script_rc, script_exec_out, sizeof(script_exec_out), &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json(crashed || script_rc != 0 ? "JLINK_SCRIPT_SELECT_FAILED" : "HSS_JLINK_SCRIPT_IDENTITY_CHANGED", "approved J-Link script selection failed or changed before target connect", dll_utf8);
    return 0;
  }
  const int tif = iface == "JTAG" ? 0 : 1;
  (void)call_int1(arm_tif, tif, &crashed);
  call_void1(arm_speed, speed, &crashed);
  ArtifactMatchConnectionState artifact_match_connection;
  int connect_rc = call_int0(arm_connect, &crashed);
  if (crashed || connect_rc < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_CONNECT_FAILED", "JLINKARM_Connect failed", dll_utf8);
    return 0;
  }
  const uint64_t connect_ordinal = artifact_match_connection.connected();
  int halted_before_resume = -1;
  int halted_after_resume = -1;
  if (arm_halted) {
    halted_before_resume = call_int0(arm_halted, &crashed);
    if (crashed) halted_before_resume = -2;
  }
  if (resume_before_start) {
    if (!arm_go) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("JLINK_GO_MISSING", "JLINKARM_Go export missing", dll_utf8);
      return 0;
    }
    call_void0(arm_go, &crashed);
    if (crashed) {
      call_void0(arm_close, &crashed);
      FreeLibrary(dll);
      error_json("JLINK_GO_EXCEPTION", "JLINKARM_Go raised a structured exception", dll_utf8);
      return 0;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (arm_halted) {
    halted_after_resume = call_int0(arm_halted, &crashed);
    if (crashed) halted_after_resume = -2;
  }

  PostConnectStabilityEvidence post_connect_evidence;
  std::string post_connect_error_code;
  std::string post_connect_error_reason;
  const bool post_connect_stable = !post_connect_stability_required || wait_for_post_connect_stability(
    arm_halted,
    arm_read_u32,
    post_connect_counter_address,
    post_connect_expected_rate_hz,
    post_connect_rate_tolerance_ratio,
    post_connect_minimum_recovery_ms,
    post_connect_timeout_ms,
    post_connect_poll_interval_ms,
    post_connect_required_checks,
    &post_connect_evidence,
    &post_connect_error_code,
    &post_connect_error_reason);
  if (!post_connect_stable) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    stream_fault(capture_id, post_connect_error_code, post_connect_error_reason, qpc_counter());
    std::cout
      << "{\"record\":\"result\",\"status\":\"error\",\"errorCode\":\"" << post_connect_error_code
      << "\",\"reason\":\"" << escape(post_connect_error_reason)
      << "\",\"dll\":\"" << escape(dll_utf8)
      << "\",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
      << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
      << ",\"dllVersion\":" << dll_version
      << ",\"jlinkScriptMode\":\"" << script_selection.mode << "\""
      << ",\"jlinkScriptFile\":\"" << escape(script_selection.pathUtf8) << "\""
      << ",\"jlinkScriptSha256\":\"" << escape(script_selection.sha256) << "\""
      << ",\"jlinkScriptReturnCode\":" << script_rc
      << ",\"captureId\":\"" << escape(capture_id)
      << "\",\"qpcEpochCounter\":\"" << qpc_epoch << "\",\"qpcFrequency\":\"" << actual_qpc_frequency
      << "\",\"hssStartIssued\":false,\"rawOpened\":false,\"rawClosed\":false";
    write_post_connect_evidence(post_connect_evidence);
    std::cout << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
    return 0;
  }

  ArtifactMatchResult artifact_match_result;
  if (connect_ordinal != artifact_match_manifest.connectOrdinal) {
    artifact_match_result.reason = "artifact match connectOrdinal does not bind the current J-Link connection";
    artifact_match_result.gateErrorCode = "ARTIFACT_MATCH_BINDING_MISMATCH";
  } else if (!arm_read_mem) {
    artifact_match_result.reason = "JLINKARM_ReadMem export is unavailable; read-only capture continued";
  } else {
    artifact_match_result = compare_artifact_ranges(artifact_match_manifest, [&](U32 address, U32 count, U8* data, std::string* reason) {
      bool read_crashed = false;
      const int read_rc = call_read_mem(arm_read_mem, address, count, data, &read_crashed);
      if (read_crashed || read_rc < 0) {
        *reason = "JLINKARM_ReadMem failed the nonvolatile read";
        return false;
      }
      return true;
    });
  }
  if (artifact_match_result.status == ArtifactMatchStatus::verified
      && !artifact_match_connection.recordVerified(connect_ordinal)) {
    artifact_match_result.status = ArtifactMatchStatus::unverified;
    artifact_match_result.reason = "artifact match verification does not bind the current J-Link connection";
    artifact_match_result.gateErrorCode = "ARTIFACT_MATCH_BINDING_MISMATCH";
  }
  if (artifact_match_result.status == ArtifactMatchStatus::verified && !artifact_match_connection.consumeVerified(connect_ordinal)) {
    artifact_match_result.status = ArtifactMatchStatus::unverified;
    artifact_match_result.reason = "verified artifact match was stale or already consumed";
    artifact_match_result.gateErrorCode = "ARTIFACT_MATCH_VERIFICATION_STALE";
  }
  stream_artifact_match(capture_id, qpc_counter(), artifact_match_manifest, artifact_match_manifest_sha256, artifact_match_result);
  if (!artifact_match_capture_allowed(artifact_match_result)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    const std::string& code = artifact_match_result.gateErrorCode;
    stream_fault(capture_id, code, artifact_match_result.reason, qpc_counter());
    artifact_match_gate_error(code, artifact_match_result.reason, capture_id, artifact_match_manifest_sha256, &artifact_match_manifest, &artifact_match_result, qpc_epoch, actual_qpc_frequency);
    return 0;
  }
  if (!raw_writer.open(output_path)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    artifact_match_gate_error("HSS_OUTPUT_OPEN_FAILED", "raw/samples.bin must be new and exclusively creatable", capture_id, artifact_match_manifest_sha256, &artifact_match_manifest, &artifact_match_result, qpc_epoch, actual_qpc_frequency);
    return 0;
  }

  auto block_plan = build_hss_block_plan(symbols);
  auto& blocks = block_plan.blocks;
  const auto& symbol_offsets = block_plan.symbolOffsets;
  const U32 bytes_per_sample = block_plan.bytesPerSample;
  const U32 hss_sample_header_bytes = 4;
  const U32 hss_sample_stride_bytes = hss_sample_header_bytes + bytes_per_sample;
  const U32 period_us = static_cast<U32>((1000000 / requested_rate) > 1 ? (1000000 / requested_rate) : 1);
  int start_rc = call_hss_start(hss_start, blocks.data(), static_cast<U32>(blocks.size()), period_us, &crashed);
  const int64_t hss_start_qpc = qpc_counter();
  stream_lifecycle(capture_id, "hss_start", hss_start_qpc, ",\"returnCode\":" + std::to_string(start_rc) + ",\"crashed\":" + (crashed ? "true" : "false"));
  if (crashed || start_rc < 0) {
    const bool raw_closed = raw_writer.finalize();
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    stream_fault(capture_id, "HSS_START_FAILED", "JLINK_HSS_Start failed", qpc_counter());
    std::cout << "{\"record\":\"result\",\"status\":\"error\",\"errorCode\":\"HSS_START_FAILED\",\"reason\":\"JLINK_HSS_Start failed\",\"captureId\":\"" << escape(capture_id)
              << "\",\"qpcEpochCounter\":\"" << qpc_epoch << "\",\"qpcFrequency\":\"" << actual_qpc_frequency
              << "\",\"hssStartIssued\":true,\"rawOpened\":true,\"rawClosed\":"
              << (raw_closed ? "true" : "false");
    write_artifact_match_evidence(artifact_match_manifest, artifact_match_manifest_sha256, artifact_match_result);
    std::cout << "}";
    return 0;
  }
  uint64_t started_tick = 0;
  if (!qpc_delta_ns(hss_start_qpc, qpc_epoch, actual_qpc_frequency, &started_tick)) {
    const bool raw_closed = raw_writer.finalize();
    bool stop_crashed = false;
    (void)call_hss_stop(hss_stop, &stop_crashed);
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("HSS_QPC_TIMEBASE_INVALID", raw_closed
      ? "HSS Start counter cannot be converted through the pre-reset QPC epoch"
      : "HSS Start counter conversion and raw close failed");
    return 0;
  }
  const U32 read_buffer_bytes = (std::max)(hss_sample_stride_bytes, 4096U);
  std::vector<unsigned char> read_buffer(read_buffer_bytes);
  uint64_t valid_samples = 0;
  uint64_t read_errors = 0;
  uint64_t read_attempts = 0;
  uint64_t decoded_samples = 0;
  uint64_t empty_reads = 0;
  uint64_t short_reads = 0;
  uint64_t unchanged_reads = 0;
  uint64_t changed_reads = 0;
  uint64_t sample_prefix_changed_reads = 0;
  uint64_t header_changed_reads = 0;
  uint64_t payload_changed_reads = 0;
  int first_read_rc = 0;
  int last_read_rc = 0;
  int min_read_rc = 0;
  int max_read_rc = 0;
  bool first_read_buffer_changed = false;
  bool last_read_buffer_changed = false;
  bool first_read_sample_prefix_changed = false;
  bool last_read_sample_prefix_changed = false;
  bool target_written = false;
  bool stop_requested = false;
  bool budget_exhausted = false;
  bool raw_write_failed = false;
  int first_changed_offset = -1;
  std::string first_changed_bytes;
  int payload_first_changed_offset = -1;
  std::string payload_first_changed_bytes;
  const int64_t started_ns = now_ns();
  if (read_mode == "drain") {
    const int64_t drain_until_ns = started_ns + static_cast<int64_t>(duration_sec) * 1000000000LL;
    while (now_ns() < drain_until_ns) {
      if (!stop_file.empty() && GetFileAttributesA(stop_file.c_str()) != INVALID_FILE_ATTRIBUTES) {
        stop_requested = true;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  HssRecordSequence record_sequence;
  const HssMemoryIpc memory_ipc{write_request_file, write_response_file, capture_id, arm_read_mem, arm_write_mem, arm_read_u8, arm_read_u16, arm_read_u32, arm_write_u8, arm_write_u16, arm_write_u32, arm_halted, arm_go, artifact_match_write_allowed(artifact_match_result)};
  for (uint64_t attempt = 0; attempt < requested_samples && record_sequence.emittedSamples < requested_samples
      && !record_sequence.invalid && !budget_exhausted && !raw_write_failed; ++attempt) {
    if (!stop_file.empty() && GetFileAttributesA(stop_file.c_str()) != INVALID_FILE_ATTRIBUTES) {
      stop_requested = true;
      break;
    }
    (void)handle_hss_memory_request(memory_ipc, &target_written);
    if (read_mode == "periodic") {
      while (true) {
        const int64_t wait_ns = sample_due_ns(started_ns, attempt, requested_rate) - now_ns();
        if (wait_ns <= 0) break;
        std::this_thread::sleep_for(std::chrono::nanoseconds(std::min<int64_t>(wait_ns, 1'000'000)));
      }
    }
    std::fill(read_buffer.begin(), read_buffer.end(), 0xA5);
    int read_rc = call_hss_read(hss_read, read_buffer.data(), read_buffer_bytes, &crashed);
    ++read_attempts;
    const bool buffer_changed = hss_buffer_overwritten(read_buffer, 0xA5);
    const bool sample_prefix_changed = hss_sample_prefix_overwritten(read_buffer, hss_sample_stride_bytes, 0xA5);
    const bool header_changed = hss_range_overwritten(read_buffer, 0, hss_sample_header_bytes, 0xA5);
    const bool payload_changed = hss_range_overwritten(read_buffer, hss_sample_header_bytes, bytes_per_sample, 0xA5);
    if (!buffer_changed) ++unchanged_reads;
    else ++changed_reads;
    if (sample_prefix_changed) ++sample_prefix_changed_reads;
    if (header_changed) ++header_changed_reads;
    if (payload_changed) ++payload_changed_reads;
    if (buffer_changed && first_changed_offset < 0) {
      first_changed_offset = hss_first_changed_offset(read_buffer, 0xA5);
      first_changed_bytes = bytes_hex(hss_changed_window(read_buffer, first_changed_offset));
    }
    if (payload_changed && payload_first_changed_offset < 0) {
      payload_first_changed_offset = hss_first_changed_offset_in_range(read_buffer, hss_sample_header_bytes, bytes_per_sample, 0xA5);
      payload_first_changed_bytes = bytes_hex(hss_changed_window(read_buffer, payload_first_changed_offset));
    }
    if (attempt == 0) {
      first_read_rc = read_rc;
      min_read_rc = read_rc;
      max_read_rc = read_rc;
      first_read_buffer_changed = buffer_changed;
      first_read_sample_prefix_changed = sample_prefix_changed;
    } else {
      min_read_rc = (std::min)(min_read_rc, read_rc);
      max_read_rc = (std::max)(max_read_rc, read_rc);
    }
    last_read_rc = read_rc;
    last_read_buffer_changed = buffer_changed;
    last_read_sample_prefix_changed = sample_prefix_changed;
    uint64_t samples_in_read = 0;
    if (!crashed && hss_sample_stride_bytes > hss_sample_header_bytes && read_rc >= static_cast<int>(hss_sample_stride_bytes)) {
      samples_in_read = static_cast<uint64_t>((std::min)(static_cast<U32>(read_rc), read_buffer_bytes) / hss_sample_stride_bytes);
    } else if (!crashed && read_rc == 0 && sample_prefix_changed) {
      samples_in_read = 1;
    } else if (read_rc == 0) {
      ++empty_reads;
    } else {
      ++short_reads;
    }
    if (crashed || read_rc < 0 || (read_rc > 0 && read_rc < static_cast<int>(hss_sample_stride_bytes))) ++read_errors;
    for (uint64_t batch_sample = 0; batch_sample < samples_in_read && record_sequence.emittedSamples < requested_samples; ++batch_sample) {
      std::vector<uint32_t> values;
      values.reserve(symbols.size());
      size_t offset = static_cast<size_t>(batch_sample) * hss_sample_stride_bytes;
      uint32_t hss_sample_index = 0;
      for (U32 byte = 0; byte < hss_sample_header_bytes; ++byte) hss_sample_index |= static_cast<uint32_t>(read_buffer[offset + byte]) << (byte * 8);
      offset += hss_sample_header_bytes;
      for (size_t symbol_index = 0; symbol_index < symbols.size(); ++symbol_index) {
        const auto& symbol = symbols[symbol_index];
        uint32_t raw = 0;
        const size_t symbol_offset = offset + symbol_offsets[symbol_index];
        if (symbol_offset + symbol.size <= read_buffer.size()) {
          for (U32 byte = 0; byte < symbol.size; ++byte) raw |= static_cast<uint32_t>(read_buffer[symbol_offset + byte]) << (byte * 8);
        }
        values.push_back(raw);
      }
      uint32_t status_flags = 0;
      if (require_first_sample_index_zero && !record_sequence.hasSample && hss_sample_index != 0U) {
        record_sequence.invalid = true;
        break;
      }
      HssRecordSequence candidate_sequence = record_sequence;
      const HssSampleDecision decision = observe_hss_sample(&candidate_sequence, hss_sample_index, &status_flags);
      if (decision == HssSampleDecision::duplicate) {
        record_sequence = candidate_sequence;
        ++decoded_samples;
        continue;
      }
      if (decision == HssSampleDecision::invalid) {
        record_sequence = candidate_sequence;
        ++decoded_samples;
        break;
      }
      const uint64_t sample_tick = started_tick + static_cast<uint64_t>(hss_sample_index) * 1000000000ULL / static_cast<uint64_t>(requested_rate);
      const JcapAppendResult append_result = raw_writer.append(hss_sample_index, sample_tick, status_flags, symbols, values);
      if (append_result == JcapAppendResult::budgetExhausted) {
        budget_exhausted = true;
        break;
      }
      if (append_result == JcapAppendResult::failed) {
        raw_write_failed = true;
        break;
      }
      record_sequence = candidate_sequence;
      ++decoded_samples;
      ++valid_samples;
    }
    if (crashed || record_sequence.invalid || budget_exhausted || raw_write_failed) break;
  }
  const bool raw_closed = raw_writer.finalize();
  if (raw_write_failed || !raw_closed) stream_fault(capture_id, "HSS_RAW_WRITE_FAILED", "raw/samples.bin append, flush, or close failed", qpc_counter());
  if (record_sequence.invalid) stream_fault(capture_id, "HSS_SAMPLE_INDEX_INVALID", "HSS sample index decreased or wrapped", qpc_counter());
  if (crashed || read_errors > 0) stream_fault(capture_id, "HSS_READ_FAILED", "JLINK_HSS_Read failed or returned a short record", qpc_counter());
  if (budget_exhausted) stream_lifecycle(capture_id, "sample_budget_stop", qpc_counter(), ",\"samplesBytes\":" + std::to_string(raw_writer.bytes()) + ",\"samplesByteBudget\":" + std::to_string(JcapSampleWriter::kByteBudget));
  const bool read_crashed = crashed;
  bool stop_crashed = false;
  int stop_rc = call_hss_stop(hss_stop, &stop_crashed);
  stream_lifecycle(capture_id, "hss_stop", qpc_counter(), ",\"returnCode\":" + std::to_string(stop_rc) + ",\"crashed\":" + (stop_crashed ? "true" : "false"));
  if (stop_crashed || stop_rc < 0) stream_fault(capture_id, "HSS_STOP_FAILED", "JLINK_HSS_Stop failed", qpc_counter());
  bool close_crashed = false;
  call_void0(arm_close, &close_crashed);
  FreeLibrary(dll);
  std::string samples_sha256;
  const bool raw_hashed = raw_closed && sha256_file(output_path, &samples_sha256);
  if (!raw_hashed) stream_fault(capture_id, "HSS_RAW_HASH_FAILED", "closed raw/samples.bin could not be hashed", qpc_counter());
  const int64_t elapsed_ns = std::max<int64_t>(1, now_ns() - started_ns);
  const double actual_rate = static_cast<double>(record_sequence.emittedSamples) * 1000000000.0 / static_cast<double>(elapsed_ns);
  const uint64_t sample_count = record_sequence.emittedSamples;
  const double header_changed_ratio = read_attempts > 0 ? static_cast<double>(header_changed_reads) / static_cast<double>(read_attempts) : 0.0;
  const double payload_changed_ratio = read_attempts > 0 ? static_cast<double>(payload_changed_reads) / static_cast<double>(read_attempts) : 0.0;
  const bool read_failed = !stop_requested && hss_capture_failed(read_crashed, record_sequence.emittedSamples);
  const bool lifecycle_validated = start_rc >= 0 && read_attempts > 0 && decoded_samples > 0 && stop_rc >= 0
    && !read_crashed && !stop_crashed && !close_crashed && raw_closed && raw_hashed;
  const bool decoder_semantics_validated = !record_sequence.invalid
    && record_sequence.emittedSamples > 0
    && decoded_samples == record_sequence.emittedSamples + record_sequence.duplicateSamples
    && (stop_requested || budget_exhausted || record_sequence.emittedSamples + record_sequence.droppedSamples >= requested_samples)
    && read_errors == 0 && !raw_write_failed;
  const bool validation_failed = read_failed || raw_write_failed || !lifecycle_validated || !decoder_semantics_validated;
  std::cout
    << "{\"record\":\"result\",\"status\":\"" << (validation_failed ? "error" : stop_requested || budget_exhausted ? "stopped" : "ok") << "\"";
  if (validation_failed) {
    std::cout << ",\"errorCode\":\"" << (record_sequence.invalid ? "HSS_SAMPLE_INDEX_INVALID" : !lifecycle_validated ? "HSS_LIFECYCLE_VALIDATION_FAILED" : !decoder_semantics_validated ? "HSS_DECODE_VALIDATION_FAILED" : "HSS_READ_FAILED")
              << "\",\"reason\":\"JLINK_HSS Start/Read/Stop or decoded sample validation failed\"";
  }
  std::cout
    << ",\"helperVersion\":\"" << HSS_HELPER_VERSION << "\""
    << ",\"helperProtocolVersion\":" << HSS_HELPER_PROTOCOL_VERSION
    << ",\"dllVersion\":" << dll_version
    << ",\"jlinkScriptMode\":\"" << script_selection.mode << "\""
    << ",\"jlinkScriptFile\":\"" << escape(script_selection.pathUtf8) << "\""
    << ",\"jlinkScriptSha256\":\"" << escape(script_selection.sha256) << "\""
    << ",\"jlinkScriptReturnCode\":" << script_rc
    << ",\"jlinkScriptExecOutput\":\"" << escape(script_exec_out) << "\""
    << ",\"captureId\":\"" << escape(capture_id)
    << "\",\"qpcEpochCounter\":\"" << qpc_epoch << "\""
    << ",\"qpcFrequency\":\"" << actual_qpc_frequency << "\""
    << ",\"backend\":\"jlink-hss\",\"requestedRateHz\":" << requested_rate
     << ",\"readMode\":\"" << read_mode << "\""
     << ",\"resetBeforeCapture\":" << (require_first_sample_index_zero ? "true" : "false")
    << ",\"resumeBeforeStart\":" << (resume_before_start ? "true" : "false")
    << ",\"resumeIssued\":" << (resume_before_start ? "true" : "false")
    << ",\"targetWasHaltedBeforeResume\":" << (halted_before_resume > 0 ? "true" : "false")
    << ",\"targetHaltedBeforeResumeRaw\":" << halted_before_resume
    << ",\"targetWasHaltedAfterResume\":" << (halted_after_resume > 0 ? "true" : "false")
    << ",\"targetHaltedAfterResumeRaw\":" << halted_after_resume
    << ",\"actualRateHz\":" << actual_rate
    << ",\"durationSec\":" << (static_cast<double>(elapsed_ns) / 1000000000.0)
     << ",\"sampleCount\":" << sample_count
     << ",\"requestedSamples\":" << requested_samples
     << ",\"sampleBudgetExhausted\":" << (budget_exhausted ? "true" : "false")
     << ",\"samplesByteBudget\":" << JcapSampleWriter::kByteBudget
     << ",\"samplesBytes\":" << raw_writer.bytes()
     << ",\"samplesSha256\":\"" << samples_sha256 << "\""
     << ",\"hssStartIssued\":true,\"rawOpened\":true"
     << ",\"rawClosed\":" << (raw_closed ? "true" : "false")
     << ",\"validSamples\":" << valid_samples
     << ",\"emittedSamples\":" << record_sequence.emittedSamples
     << ",\"duplicateSamples\":" << record_sequence.duplicateSamples
     << ",\"readErrors\":" << read_errors
    << ",\"hssBlockCount\":" << blocks.size()
    << ",\"hssSampleHeaderBytes\":" << hss_sample_header_bytes
    << ",\"hssSampleStrideBytes\":" << hss_sample_stride_bytes
    << ",\"readAttempts\":" << read_attempts
    << ",\"decodedSamples\":" << decoded_samples
    << ",\"startReturnCode\":" << start_rc
    << ",\"lifecycleValidated\":" << (lifecycle_validated ? "true" : "false")
    << ",\"decoderSemanticsValidated\":" << (decoder_semantics_validated ? "true" : "false")
    << ",\"emptyReads\":" << empty_reads
    << ",\"shortReads\":" << short_reads
     << ",\"missingSamples\":" << record_sequence.droppedSamples
    << ",\"bytesPerSample\":" << bytes_per_sample
    << ",\"readBufferBytes\":" << read_buffer_bytes
    << ",\"firstReadReturnCode\":" << first_read_rc
    << ",\"lastReadReturnCode\":" << last_read_rc
    << ",\"minReadReturnCode\":" << min_read_rc
    << ",\"maxReadReturnCode\":" << max_read_rc
    << ",\"firstReadBufferChanged\":" << (first_read_buffer_changed ? "true" : "false")
    << ",\"lastReadBufferChanged\":" << (last_read_buffer_changed ? "true" : "false")
    << ",\"firstReadSamplePrefixChanged\":" << (first_read_sample_prefix_changed ? "true" : "false")
    << ",\"lastReadSamplePrefixChanged\":" << (last_read_sample_prefix_changed ? "true" : "false")
    << ",\"unchangedReads\":" << unchanged_reads
    << ",\"changedReads\":" << changed_reads
    << ",\"samplePrefixChangedReads\":" << sample_prefix_changed_reads
    << ",\"headerChangedReads\":" << header_changed_reads
    << ",\"payloadChangedReads\":" << payload_changed_reads
    << ",\"firstChangedOffset\":" << first_changed_offset
    << ",\"firstChangedBytes\":\"" << first_changed_bytes << "\""
    << ",\"headerChangedRatio\":" << header_changed_ratio
    << ",\"payloadChangedRatio\":" << payload_changed_ratio
    << ",\"payloadFirstChangedOffset\":" << payload_first_changed_offset
    << ",\"payloadFirstChangedBytes\":\"" << payload_first_changed_bytes << "\""
    << ",\"layout\":{\"hssSampleHeaderBytes\":" << hss_sample_header_bytes
    << ",\"hssSampleStrideBytes\":" << hss_sample_stride_bytes
    << ",\"bytesPerSample\":" << bytes_per_sample
    << ",\"hssBlockCount\":" << blocks.size()
    << ",\"readBufferBytes\":" << read_buffer_bytes
    << ",\"firstChangedOffset\":" << first_changed_offset
    << ",\"firstChangedBytes\":\"" << first_changed_bytes << "\""
    << ",\"headerChangedRatio\":" << header_changed_ratio
    << ",\"payloadChangedRatio\":" << payload_changed_ratio
    << ",\"payloadFirstChangedOffset\":" << payload_first_changed_offset
    << ",\"payloadFirstChangedBytes\":\"" << payload_first_changed_bytes << "\"}"
     << ",\"timeouts\":0,\"overflows\":0,\"droppedSamples\":" << record_sequence.droppedSamples;
  write_post_connect_evidence(post_connect_evidence);
  write_artifact_match_evidence(artifact_match_manifest, artifact_match_manifest_sha256, artifact_match_result);
  std::cout
    << ",\"targetReset\":false,\"targetWritten\":" << (target_written ? "true" : "false")
    << ",\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false"
     << ",\"segment\":{\"file\":\"samples.bin\",\"sampleStart\":" << (record_sequence.hasSample ? record_sequence.firstSampleIndex : 0)
     << ",\"sampleCount\":" << sample_count
    << ",\"sha256\":\"" << samples_sha256 << "\"},\"stopReturnCode\":" << stop_rc << "}";
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) {
    error_json("HSS_HELPER_USAGE", "missing command");
    return 0;
  }
  const std::wstring command = argv[1];
  const auto options = parse_options(argc, argv);
  const auto dll_it = options.find(L"--dll");
  const std::wstring dll_path = dll_it == options.end() ? L"" : dll_it->second;
  if (command == L"version") return version();
  if (command == L"qpc-timebase") return qpc_timebase();
  if ((command == L"preflight" || command == L"getcaps") && dll_path.empty()) {
    error_json("HSS_DLL_PATH_MISSING", "--dll is required");
    return 0;
  }
  if (command == L"preflight") return preflight(dll_path);
  if (command == L"getcaps") return getcaps(dll_path, options);
  if (command == L"connect-preflight") return connect_preflight(dll_path, options);
  if (command == L"read-ram-probe") return read_ram_probe(dll_path, options);
  if (command == L"self-test") return self_test();
  if (command == L"cpu-control") return cpu_control(options, false);
  if (command == L"target-state") return cpu_control(options, true);
  if (command == L"variable-write") return variable_write(options);
  if (command == L"variable-write-r4") return variable_write_r4(argc, argv, options);
  if (command == L"hss-capture") return hss_capture(options);
  if (command == L"hss-smoke" || command == L"hss-benchmark") {
    error_json("HSS_START_READ_STOP_NOT_AUTHORIZED_YET", "connect-preflight must pass before enabling HSS Start/Read/Stop candidate calls", narrow(dll_path));
    return 0;
  }
  error_json("HSS_HELPER_UNKNOWN_COMMAND", "unknown command");
  return 0;
}
