#include <windows.h>

#include <cstdint>
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

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

static std::string narrow(const std::wstring& input) {
  if (input.empty()) return "";
  int size = WideCharToMultiByte(CP_UTF8, 0, input.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string output(size > 0 ? size - 1 : 0, '\0');
  if (size > 0) WideCharToMultiByte(CP_UTF8, 0, input.c_str(), -1, output.data(), size, nullptr, nullptr);
  return output;
}

static std::string escape(const std::string& input) {
  std::ostringstream out;
  for (char ch : input) {
    switch (ch) {
      case '\\': out << "\\\\"; break;
      case '"': out << "\\\""; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default: out << ch; break;
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
    << "\",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
}

static bool env_enabled(const char* name) {
  char value[16] = {};
  DWORD size = GetEnvironmentVariableA(name, value, sizeof(value));
  return size == 1 && value[0] == '1';
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

static uint32_t crc32_update(uint32_t crc, const void* data, size_t size) {
  const auto* bytes = static_cast<const unsigned char*>(data);
  for (size_t i = 0; i < size; ++i) {
    crc ^= bytes[i];
    for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xEDB88320U & (0U - (crc & 1U)));
  }
  return crc;
}

static int64_t now_ns() {
  LARGE_INTEGER counter{};
  LARGE_INTEGER frequency{};
  QueryPerformanceCounter(&counter);
  QueryPerformanceFrequency(&frequency);
  return static_cast<int64_t>((static_cast<long double>(counter.QuadPart) * 1000000000.0L) / static_cast<long double>(frequency.QuadPart));
}

static std::string read_text_file(const std::wstring& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) return "";
  std::ostringstream out;
  out << file.rdbuf();
  return out.str();
}

static std::string json_string(const std::string& text, const char* name, const char* fallback = "") {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? match[1].str() : std::string(fallback);
}

static int json_int(const std::string& text, const char* name, int fallback = 0) {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*(\\d+)");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? std::stoi(match[1].str()) : fallback;
}

struct PlanSymbol {
  std::string name;
  U32 address;
  U32 size;
};

static std::vector<PlanSymbol> json_symbols(const std::string& text) {
  std::vector<PlanSymbol> symbols;
  std::regex pattern("\\{[^{}]*\"name\"\\s*:\\s*\"([^\"]+)\"[^{}]*\"address\"\\s*:\\s*\"0x([0-9a-fA-F]+)\"[^{}]*\"size\"\\s*:\\s*(\\d+)[^{}]*\\}");
  for (std::sregex_iterator it(text.begin(), text.end(), pattern), end; it != end; ++it) {
    symbols.push_back({(*it)[1].str(), static_cast<U32>(std::stoul((*it)[2].str(), nullptr, 16)), static_cast<U32>(std::stoul((*it)[3].str()))});
  }
  return symbols;
}

static void write_record(std::ofstream& out, uint64_t sample_index, int64_t timestamp_ticks, uint32_t status_flags, const std::vector<uint32_t>& values, uint32_t* crc) {
  out.write(reinterpret_cast<const char*>(&sample_index), sizeof(sample_index));
  out.write(reinterpret_cast<const char*>(&timestamp_ticks), sizeof(timestamp_ticks));
  out.write(reinterpret_cast<const char*>(&status_flags), sizeof(status_flags));
  uint32_t reserved = 0;
  out.write(reinterpret_cast<const char*>(&reserved), sizeof(reserved));
  *crc = crc32_update(*crc, &sample_index, sizeof(sample_index));
  *crc = crc32_update(*crc, &timestamp_ticks, sizeof(timestamp_ticks));
  *crc = crc32_update(*crc, &status_flags, sizeof(status_flags));
  *crc = crc32_update(*crc, &reserved, sizeof(reserved));
  for (uint32_t value : values) {
    out.write(reinterpret_cast<const char*>(&value), sizeof(value));
    *crc = crc32_update(*crc, &value, sizeof(value));
  }
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
  std::cout
    << "{\"status\":\"ok\",\"dll\":\"" << escape(dll_utf8)
    << "\",\"exports\":{\"JLINK_HSS_GetCaps\":" << (getcaps ? "true" : "false")
    << ",\"JLINK_HSS_Start\":" << (start ? "true" : "false")
    << ",\"JLINK_HSS_Read\":" << (read ? "true" : "false")
    << ",\"JLINK_HSS_Stop\":" << (stop ? "true" : "false")
    << "},\"exportsFound\":" << (getcaps && start && read && stop ? "true" : "false")
    << ",";
  required_base_json(arm_open, arm_close, arm_exec, arm_tif, arm_speed, arm_connect);
  std::cout
    << ",\"baseApiCandidate\":\"AUTHORIZED_UNVERIFIED_BASE_API_CANDIDATE\""
    << ",\"candidateApi\":\"HSS_PUBLIC_PROTOTYPE_CANDIDATE_USED_FOR_EXPERIMENT\"}";
  FreeLibrary(dll);
  return 0;
}

static int getcaps(const std::wstring& dll_path) {
  HMODULE dll = LoadLibraryW(dll_path.c_str());
  const std::string dll_utf8 = narrow(dll_path);
  if (!dll) {
    error_json("HSS_DLL_LOAD_FAILED", "LoadLibraryW failed", dll_utf8);
    return 0;
  }
  auto fn = reinterpret_cast<JLINK_HSS_GetCaps_Fn>(required(dll, "JLINK_HSS_GetCaps"));
  if (!fn) {
    FreeLibrary(dll);
    error_json("HSS_EXPORT_MISSING", "JLINK_HSS_GetCaps export was not found", dll_utf8);
    return 0;
  }
  JLINK_HSS_CAPS caps{};
  bool crashed = false;
  int return_code = call_getcaps(fn, &caps, &crashed);
  if (crashed) {
    FreeLibrary(dll);
    error_json("HSS_GETCAPS_EXCEPTION", "JLINK_HSS_GetCaps raised a structured exception", dll_utf8);
    return 0;
  }
  std::cout
    << "{\"status\":\"ok\",\"api\":\"JLINK_HSS_GetCaps\",\"dll\":\"" << escape(dll_utf8)
    << "\",\"dllVersion\":\"unknown\",\"returnCode\":" << return_code
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

static int self_test() {
  wchar_t temporaryDirectory[MAX_PATH]{};
  wchar_t temporaryFile[MAX_PATH]{};
  if (GetTempPathW(MAX_PATH, temporaryDirectory) == 0 || GetTempFileNameW(temporaryDirectory, L"hss", 0, temporaryFile) == 0) {
    error_json("HSS_SELF_TEST_TEMP_FAILED", "could not create temp file");
    return 0;
  }
  std::ofstream out(temporaryFile, std::ios::binary | std::ios::trunc);
  if (!out) {
    error_json("HSS_SELF_TEST_WRITE_FAILED", "could not open temp capture");
    return 0;
  }
  uint32_t crc = 0xFFFFFFFFU;
  write_record(out, 0, 0, 1, {1, 2}, &crc);
  write_record(out, 1, 1000000, 1, {17, 18}, &crc);
  out.close();
  crc ^= 0xFFFFFFFFU;
  DeleteFileW(temporaryFile);
  std::cout
    << "{\"status\":\"ok\",\"command\":\"self-test\",\"recordFormat\":\"uint64,int64,uint32,uint32,uint32[]\""
    << ",\"sampleCount\":2,\"crc32\":\"" << std::hex << crc << std::dec
    << "\",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
  return 0;
}

static int hss_capture(const std::map<std::wstring, std::wstring>& options) {
  const auto plan_it = options.find(L"--plan");
  if (plan_it == options.end()) {
    error_json("HSS_PLAN_MISSING", "--plan is required");
    return 0;
  }
  if (!env_enabled("JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API") || !env_enabled("JLINK_MCP_REAL_HW_SMOKE")) {
    error_json("HSS_EXPERIMENTAL_ENV_DISABLED", "JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API=1 and JLINK_MCP_REAL_HW_SMOKE=1 are required");
    return 0;
  }
  const std::string plan = read_text_file(plan_it->second);
  if (plan.empty()) {
    error_json("HSS_PLAN_READ_FAILED", "plan file could not be read");
    return 0;
  }
  const std::string dll_utf8 = json_string(plan, "dllPath");
  const std::string output_file = json_string(plan, "outputFile");
  const std::string stop_file = json_string(plan, "stopFile");
  const std::string capture_id = json_string(plan, "captureId");
  const std::string device = json_string(plan, "device", "Z20K146MC");
  const std::string iface = json_string(plan, "interface", "SWD");
  const std::string serial_text = json_string(plan, "serial");
  const int speed = json_int(plan, "speedKhz", 4000);
  const int requested_rate = json_int(plan, "requestedRateHz", 1000);
  const int duration_sec = json_int(plan, "durationSec", 1);
  const auto symbols = json_symbols(plan);
  if (dll_utf8.empty() || output_file.empty() || capture_id.empty() || symbols.empty() || symbols.size() > 10 || requested_rate < 1 || duration_sec < 1) {
    error_json("HSS_PLAN_INVALID", "plan is missing required fields");
    return 0;
  }

  const std::wstring dll_path(dll_utf8.begin(), dll_utf8.end());
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
  auto hss_start = reinterpret_cast<JLINK_HSS_Start_Fn>(required(dll, "JLINK_HSS_Start"));
  auto hss_read = reinterpret_cast<JLINK_HSS_Read_Fn>(required(dll, "JLINK_HSS_Read"));
  auto hss_stop = reinterpret_cast<JLINK_HSS_Stop_Fn>(required(dll, "JLINK_HSS_Stop"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !hss_start || !hss_read || !hss_stop) {
    FreeLibrary(dll);
    error_json("HSS_EXPORT_MISSING", "required JLINKARM/JLINK_HSS exports missing", dll_utf8);
    return 0;
  }

  bool crashed = false;
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
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  (void)call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_EXEC_DEVICE_EXCEPTION", "JLINKARM_ExecCommand(device) raised a structured exception", dll_utf8);
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

  std::vector<JLINK_HSS_MEM_BLOCK_DESC> blocks;
  U32 bytes_per_sample = 0;
  for (const auto& symbol : symbols) {
    blocks.push_back({symbol.address, symbol.size, 0, 0});
    bytes_per_sample += symbol.size;
  }
  const U32 period_us = static_cast<U32>((1000000 / requested_rate) > 1 ? (1000000 / requested_rate) : 1);
  int start_rc = call_hss_start(hss_start, blocks.data(), static_cast<U32>(blocks.size()), period_us, &crashed);
  if (crashed || start_rc < 0) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("HSS_START_FAILED", "JLINK_HSS_Start failed", dll_utf8);
    return 0;
  }

  std::ofstream out(output_file, std::ios::binary | std::ios::trunc);
  if (!out) {
    (void)call_hss_stop(hss_stop, &crashed);
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("HSS_OUTPUT_OPEN_FAILED", "capture output file could not be opened", dll_utf8);
    return 0;
  }
  const uint64_t requested_samples = static_cast<uint64_t>(requested_rate) * static_cast<uint64_t>(duration_sec);
  std::vector<unsigned char> read_buffer(bytes_per_sample);
  uint32_t crc = 0xFFFFFFFFU;
  uint64_t valid_samples = 0;
  uint64_t read_errors = 0;
  const int64_t started_ns = now_ns();
  for (uint64_t sample = 0; sample < requested_samples; ++sample) {
    if (!stop_file.empty() && GetFileAttributesA(stop_file.c_str()) != INVALID_FILE_ATTRIBUTES) break;
    int read_rc = call_hss_read(hss_read, read_buffer.data(), bytes_per_sample, &crashed);
    std::vector<uint32_t> values;
    values.reserve(symbols.size());
    size_t offset = 0;
    for (const auto& symbol : symbols) {
      uint32_t raw = 0;
      if (!crashed && read_rc >= static_cast<int>(bytes_per_sample) && offset + symbol.size <= read_buffer.size()) {
        for (U32 byte = 0; byte < symbol.size; ++byte) raw |= static_cast<uint32_t>(read_buffer[offset + byte]) << (byte * 8);
      }
      values.push_back(raw);
      offset += symbol.size;
    }
    const uint32_t flags = (!crashed && read_rc >= static_cast<int>(bytes_per_sample)) ? 1U : 2U;
    if (flags == 1U) ++valid_samples;
    else ++read_errors;
    write_record(out, sample, now_ns(), flags, values, &crc);
    if (crashed) break;
  }
  out.close();
  int stop_rc = call_hss_stop(hss_stop, &crashed);
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);
  crc ^= 0xFFFFFFFFU;
  const int64_t elapsed_ns = std::max<int64_t>(1, now_ns() - started_ns);
  const double actual_rate = static_cast<double>(valid_samples) * 1000000000.0 / static_cast<double>(elapsed_ns);
  std::ostringstream crc_hex;
  crc_hex << std::hex << crc;
  std::cout
    << "{\"status\":\"ok\",\"captureId\":\"" << escape(capture_id)
    << "\",\"backend\":\"jlink-hss\",\"requestedRateHz\":" << requested_rate
    << ",\"actualRateHz\":" << actual_rate
    << ",\"durationSec\":" << (static_cast<double>(elapsed_ns) / 1000000000.0)
    << ",\"sampleCount\":" << (valid_samples + read_errors)
    << ",\"validSamples\":" << valid_samples
    << ",\"readErrors\":" << read_errors
    << ",\"timeouts\":0,\"overflows\":0,\"droppedSamples\":0"
    << ",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false"
    << ",\"segment\":{\"file\":\"capture_0001.bin\",\"sampleStart\":0,\"sampleCount\":" << (valid_samples + read_errors)
    << ",\"crc32\":\"" << crc_hex.str() << "\"},\"stopReturnCode\":" << stop_rc << "}";
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
  if ((command == L"preflight" || command == L"getcaps") && dll_path.empty()) {
    error_json("HSS_DLL_PATH_MISSING", "--dll is required");
    return 0;
  }
  if (command == L"preflight") return preflight(dll_path);
  if (command == L"getcaps") return getcaps(dll_path);
  if (command == L"connect-preflight") return connect_preflight(dll_path, options);
  if (command == L"self-test") return self_test();
  if (command == L"hss-capture") return hss_capture(options);
  if (command == L"hss-smoke" || command == L"hss-benchmark") {
    error_json("HSS_START_READ_STOP_NOT_AUTHORIZED_YET", "connect-preflight must pass before enabling HSS Start/Read/Stop candidate calls", narrow(dll_path));
    return 0;
  }
  error_json("HSS_HELPER_UNKNOWN_COMMAND", "unknown command");
  return 0;
}
