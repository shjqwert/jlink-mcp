#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <cctype>
#include <cwctype>
#include <cstdint>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
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
    << ",\"budgetStopValidated\":true,\"failureCloseValidated\":true,\"qpcTimebaseValidated\":true"
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
};

static std::string memory_response_error(const std::string& request_id, const std::string& code, const std::string& reason, bool write_issued) {
  std::ostringstream out;
  out
    << "{\"requestId\":\"" << escape(request_id)
    << "\",\"status\":\"error\",\"errorCode\":\"" << escape(code)
    << "\",\"reason\":\"" << escape(reason)
    << "\",\"writeIssued\":" << (write_issued ? "true" : "false")
    << ",\"targetReset\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
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
  const std::string address_text = json_string(request, "address");
  U32 address = 0;
  int length = json_int(request, "length", 0);
  if (request_id.empty() || capture_id != ipc.captureId || (op != "read" && op != "write") || !parse_u32_text(address_text, &address) || length < 1 || length > 4) {
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

  if (!ipc.writeMem) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "JLINK_WRITEMEM_EXPORT_MISSING", "JLINKARM_WriteMem export missing", false));
    return true;
  }
  std::vector<unsigned char> bytes;
  const std::string bytes_hex_text = json_string(request, "bytesHex");
  const int access_size = json_int(request, "accessSize", 0);
  if ((access_size != 1 && access_size != 2 && access_size != 4) || access_size != length || !parse_hex_bytes(bytes_hex_text, &bytes) || bytes.size() != static_cast<size_t>(length)) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "HSS_WRITE_BYTES_INVALID", "write bytes are malformed", false));
    return true;
  }
  if (!write_scalar_memory(ipc, address, bytes)) {
    write_text_file_a(ipc.responseFile, memory_response_error(request_id, "JLINK_WRITEMEM_FAILED", "JLINKARM_WriteMem failed", true));
    return true;
  }
  *target_written = true;
  std::ostringstream out;
  out
    << "{\"requestId\":\"" << escape(request_id)
    << "\",\"status\":\"ok\",\"op\":\"write\",\"address\":\"" << hex_u32(address)
    << "\",\"length\":" << length
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
  if (!parse_u32_text(post_connect_counter_address_text, &post_connect_counter_address)
      || post_connect_counter_type != "uint32"
      || post_connect_counter_modulus != "4294967296"
      || post_connect_expected_rate_hz < 1 || post_connect_expected_rate_hz > 1000000
      || post_connect_rate_tolerance_ratio <= 0.0 || post_connect_rate_tolerance_ratio >= 1.0
      || post_connect_minimum_recovery_ms < 0 || post_connect_minimum_recovery_ms > 60000
      || post_connect_timeout_ms < 1 || post_connect_timeout_ms > 60000
      || post_connect_poll_interval_ms < 10 || post_connect_poll_interval_ms > 1000
      || post_connect_required_checks < 2 || post_connect_required_checks > 100) {
    error_json("HSS_PLAN_INVALID", "post-connect uint32 counter stability policy is missing or invalid");
    return 0;
  }
  if (!runtime_identity_validated || !valid_sha256_hex(approved_dll_sha256)) {
    error_json("HSS_RUNTIME_IDENTITY_UNVALIDATED", "capture plan requires a validated DLL SHA-256 identity", dll_utf8);
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
  JcapSampleWriter raw_writer;
  if (!raw_writer.open(output_path)) {
    error_json("HSS_OUTPUT_OPEN_FAILED", "raw/samples.bin must be new and exclusively creatable", output_file);
    return 0;
  }
  stream_lifecycle(capture_id, "qpc_epoch", current_qpc,
    ",\"qpcEpochCounter\":\"" + std::to_string(qpc_epoch) + "\",\"qpcFrequency\":\"" + std::to_string(actual_qpc_frequency) + "\"");

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
  int connect_rc = call_int0(arm_connect, &crashed);
  if (crashed || connect_rc < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_CONNECT_FAILED", "JLINKARM_Connect failed", dll_utf8);
    return 0;
  }
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
  const bool post_connect_stable = wait_for_post_connect_stability(
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
    const bool raw_closed = raw_writer.finalize();
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
      << ",\"captureId\":\"" << escape(capture_id) << "\",\"rawClosed\":" << (raw_closed ? "true" : "false");
    write_post_connect_evidence(post_connect_evidence);
    std::cout << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
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
    std::cout << "{\"record\":\"result\",\"status\":\"error\",\"errorCode\":\"HSS_START_FAILED\",\"reason\":\"JLINK_HSS_Start failed\",\"rawClosed\":"
              << (raw_closed ? "true" : "false") << "}";
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
  const HssMemoryIpc memory_ipc{write_request_file, write_response_file, capture_id, arm_read_mem, arm_write_mem, arm_read_u8, arm_read_u16, arm_read_u32, arm_write_u8, arm_write_u16, arm_write_u32};
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
  if (command == L"hss-capture") return hss_capture(options);
  if (command == L"hss-smoke" || command == L"hss-benchmark") {
    error_json("HSS_START_READ_STOP_NOT_AUTHORIZED_YET", "connect-preflight must pass before enabling HSS Start/Read/Stop candidate calls", narrow(dll_path));
    return 0;
  }
  error_json("HSS_HELPER_UNKNOWN_COMMAND", "unknown command");
  return 0;
}
