#include <windows.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

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
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? match[1].str() : std::string(fallback);
}

static int json_int(const std::string& text, const char* name, int fallback = 0) {
  std::regex pattern(std::string("\"") + name + "\"\\s*:\\s*(\\d+)");
  std::smatch match;
  return std::regex_search(text, match, pattern) ? std::stoi(match[1].str()) : fallback;
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
  for (std::sregex_iterator it(text.begin(), text.end(), pattern), end; it != end; ++it) {
    symbols.push_back({(*it)[1].str(), static_cast<U32>(std::stoul((*it)[2].str(), nullptr, 16)), static_cast<U32>(std::stoul((*it)[3].str()))});
  }
  return symbols;
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

static bool hss_capture_failed(bool crashed, uint64_t valid_samples, uint64_t requested_samples) {
  return crashed || valid_samples < requested_samples;
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

static std::string option_utf8(const std::map<std::wstring, std::wstring>& options, const wchar_t* name, const char* fallback);

static int getcaps(const std::wstring& dll_path, const std::map<std::wstring, std::wstring>& options) {
  const std::string dll_utf8 = narrow(dll_path);
  const std::string device = option_utf8(options, L"--device", "");
  if (device.empty()) {
    error_json("HSS_GETCAPS_DEVICE_REQUIRED", "--device is required before JLINK_HSS_GetCaps candidate call", dll_utf8);
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
  auto fn = reinterpret_cast<JLINK_HSS_GetCaps_Fn>(required(dll, "JLINK_HSS_GetCaps"));
  if (!arm_open || !arm_close || !arm_exec || !arm_tif || !arm_speed || !arm_connect || !fn) {
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
  std::cout
    << "{\"status\":\"ok\",\"api\":\"JLINK_HSS_GetCaps\",\"dll\":\"" << escape(dll_utf8)
    << "\",\"dllVersion\":\"unknown\",\"returnCode\":" << return_code
    << ",\"device\":\"" << escape(device)
    << "\",\"interface\":\"" << escape(iface)
    << "\",\"speedKhz\":" << speed
    << ",\"connectReturnCode\":" << connect_rc
    << ",\"execOutput\":\"" << escape(exec_out) << "\""
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

static void write_hss_diag(const std::string& path, const std::string& capture_id, const std::string& stage, uint64_t read_attempts = 0, uint64_t valid_samples = 0, int last_read_rc = 0) {
  if (path.empty()) return;
  std::ostringstream out;
  out
    << "{\"captureId\":\"" << escape(capture_id)
    << "\",\"stage\":\"" << escape(stage)
    << "\",\"timeNs\":" << now_ns()
    << ",\"readAttempts\":" << read_attempts
    << ",\"validSamples\":" << valid_samples
    << ",\"lastReadReturnCode\":" << last_read_rc
    << "}";
  write_text_file_a(path, out.str());
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
  if (hss_capture_failed(false, 2, 2) || !hss_capture_failed(false, 1, 2) || !hss_capture_failed(false, 0, 2) || !hss_capture_failed(true, 2, 2)) {
    error_json("HSS_SELF_TEST_CAPTURE_FAILURE_FAILED", "HSS capture failure classification failed");
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
  const std::string temporaryFile = "hss_selftest_" + std::to_string(GetCurrentProcessId()) + ".bin";
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
  DeleteFileA(temporaryFile.c_str());
  std::cout
    << "{\"status\":\"ok\",\"command\":\"self-test\",\"recordFormat\":\"uint64,int64,uint32,uint32,uint32[]\""
    << ",\"sampleCount\":2,\"crc32\":\"" << std::hex << crc << std::dec
    << "\",\"targetReset\":false,\"targetWritten\":false,\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false}";
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
  const std::string output_file = json_string(plan, "outputFile");
  const std::string stop_file = json_string(plan, "stopFile");
  const std::string diagnostic_file = json_string(plan, "diagnosticFile");
  const std::string write_request_file = json_string(plan, "writeRequestFile");
  const std::string write_response_file = json_string(plan, "writeResponseFile");
  const std::string capture_id = json_string(plan, "captureId");
  const std::string device = json_string(plan, "device", "");
  const std::string iface = json_string(plan, "interface", "SWD");
  const std::string serial_text = json_string(plan, "serial");
  const std::string read_mode = json_string(plan, "readMode", "periodic");
  const bool resume_before_start = json_bool(plan, "resumeBeforeStart", false);
  const int speed = json_int(plan, "speedKhz", 4000);
  const int requested_rate = json_int(plan, "requestedRateHz", 1000);
  const int duration_sec = json_int(plan, "durationSec", 1);
  const auto symbols = json_symbols(plan);
  if (dll_utf8.empty() || output_file.empty() || capture_id.empty() || symbols.empty() || symbols.size() > 10 || requested_rate < 1 || duration_sec < 1) {
    error_json("HSS_PLAN_INVALID", "plan is missing required fields");
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

  write_hss_diag(diagnostic_file, capture_id, "load_dll");
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
  write_hss_diag(diagnostic_file, capture_id, "before_jlink_open");
  int open_rc = call_int0(arm_open, &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_jlink_open");
  if (crashed || open_rc < 0) {
    FreeLibrary(dll);
    error_json("JLINK_OPEN_FAILED", "JLINKARM_Open failed", dll_utf8);
    return 0;
  }
  write_hss_diag(diagnostic_file, capture_id, "before_suppress_gui");
  if (!suppress_jlink_gui(arm_exec, &crashed)) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_SUPPRESS_GUI_EXCEPTION", "JLINKARM_ExecCommand(SuppressGUI) raised a structured exception", dll_utf8);
    return 0;
  }
  write_hss_diag(diagnostic_file, capture_id, "after_suppress_gui");
  char exec_out[512] = {};
  const std::string device_cmd = "device = " + device;
  write_hss_diag(diagnostic_file, capture_id, "before_exec_device");
  (void)call_exec(arm_exec, device_cmd.c_str(), exec_out, sizeof(exec_out), &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_exec_device");
  if (crashed) {
    call_void0(arm_close, &crashed);
    FreeLibrary(dll);
    error_json("JLINK_EXEC_DEVICE_EXCEPTION", "JLINKARM_ExecCommand(device) raised a structured exception", dll_utf8);
    return 0;
  }
  const int tif = iface == "JTAG" ? 0 : 1;
  write_hss_diag(diagnostic_file, capture_id, "before_tif_select");
  (void)call_int1(arm_tif, tif, &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_tif_select");
  write_hss_diag(diagnostic_file, capture_id, "before_set_speed");
  call_void1(arm_speed, speed, &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_set_speed");
  write_hss_diag(diagnostic_file, capture_id, "before_jlink_connect");
  int connect_rc = call_int0(arm_connect, &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_jlink_connect");
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

  auto block_plan = build_hss_block_plan(symbols);
  auto& blocks = block_plan.blocks;
  const auto& symbol_offsets = block_plan.symbolOffsets;
  const U32 bytes_per_sample = block_plan.bytesPerSample;
  const U32 hss_sample_header_bytes = 4;
  const U32 hss_sample_stride_bytes = hss_sample_header_bytes + bytes_per_sample;
  const U32 period_us = static_cast<U32>((1000000 / requested_rate) > 1 ? (1000000 / requested_rate) : 1);
  write_hss_diag(diagnostic_file, capture_id, "before_hss_start");
  int start_rc = call_hss_start(hss_start, blocks.data(), static_cast<U32>(blocks.size()), period_us, &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_hss_start");
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
  const U32 read_buffer_bytes = (std::max)(hss_sample_stride_bytes, 4096U);
  std::vector<unsigned char> read_buffer(read_buffer_bytes);
  uint32_t crc = 0xFFFFFFFFU;
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
  uint64_t sample = 0;
  const HssMemoryIpc memory_ipc{write_request_file, write_response_file, capture_id, arm_read_mem, arm_write_mem, arm_read_u8, arm_read_u16, arm_read_u32, arm_write_u8, arm_write_u16, arm_write_u32};
  for (uint64_t attempt = 0; attempt < requested_samples && sample < requested_samples; ++attempt) {
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
    write_hss_diag(diagnostic_file, capture_id, "before_hss_read", read_attempts, valid_samples, last_read_rc);
    int read_rc = call_hss_read(hss_read, read_buffer.data(), read_buffer_bytes, &crashed);
    ++read_attempts;
    write_hss_diag(diagnostic_file, capture_id, "after_hss_read", read_attempts, valid_samples, read_rc);
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
    for (uint64_t batch_sample = 0; batch_sample < samples_in_read && sample < requested_samples; ++batch_sample) {
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
      ++valid_samples;
      ++decoded_samples;
      const int64_t sample_ns = started_ns + static_cast<int64_t>(static_cast<uint64_t>(hss_sample_index) * 1000000000ULL / static_cast<uint64_t>(requested_rate));
      write_record(out, hss_sample_index, sample_ns, 1U, values, &crc);
      ++sample;
    }
    if (samples_in_read > 0) out.flush();
    if (crashed) break;
  }
  while (!stop_requested && sample < requested_samples) {
    std::vector<uint32_t> values(symbols.size(), 0);
    ++read_errors;
    write_record(out, sample++, now_ns(), 2U, values, &crc);
  }
  out.close();
  write_hss_diag(diagnostic_file, capture_id, "before_hss_stop", read_attempts, valid_samples, last_read_rc);
  int stop_rc = call_hss_stop(hss_stop, &crashed);
  write_hss_diag(diagnostic_file, capture_id, "after_hss_stop", read_attempts, valid_samples, last_read_rc);
  call_void0(arm_close, &crashed);
  FreeLibrary(dll);
  crc ^= 0xFFFFFFFFU;
  const int64_t elapsed_ns = std::max<int64_t>(1, now_ns() - started_ns);
  const double actual_rate = static_cast<double>(valid_samples) * 1000000000.0 / static_cast<double>(elapsed_ns);
  const uint64_t sample_count = valid_samples + read_errors;
  const double header_changed_ratio = read_attempts > 0 ? static_cast<double>(header_changed_reads) / static_cast<double>(read_attempts) : 0.0;
  const double payload_changed_ratio = read_attempts > 0 ? static_cast<double>(payload_changed_reads) / static_cast<double>(read_attempts) : 0.0;
  const bool read_failed = !stop_requested && hss_capture_failed(crashed, valid_samples, requested_samples);
  std::ostringstream crc_hex;
  crc_hex << std::hex << crc;
  std::cout
    << "{\"status\":\"" << (read_failed ? "error" : stop_requested ? "stopped" : "ok") << "\"";
  if (read_failed) {
    std::cout << ",\"errorCode\":\"HSS_READ_FAILED\",\"reason\":\"JLINK_HSS_Read did not produce a complete valid sample set\"";
  }
  std::cout
    << ",\"captureId\":\"" << escape(capture_id)
    << "\",\"backend\":\"jlink-hss\",\"requestedRateHz\":" << requested_rate
    << ",\"readMode\":\"" << read_mode << "\""
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
    << ",\"validSamples\":" << valid_samples
    << ",\"readErrors\":" << read_errors
    << ",\"hssBlockCount\":" << blocks.size()
    << ",\"hssSampleHeaderBytes\":" << hss_sample_header_bytes
    << ",\"hssSampleStrideBytes\":" << hss_sample_stride_bytes
    << ",\"readAttempts\":" << read_attempts
    << ",\"decodedSamples\":" << decoded_samples
    << ",\"emptyReads\":" << empty_reads
    << ",\"shortReads\":" << short_reads
    << ",\"missingSamples\":" << read_errors
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
    << ",\"timeouts\":0,\"overflows\":0,\"droppedSamples\":0"
    << ",\"targetReset\":false,\"targetWritten\":" << (target_written ? "true" : "false")
    << ",\"flashIssued\":false,\"resetIssued\":false,\"haltIssued\":false"
    << ",\"segment\":{\"file\":\"capture_0001.bin\",\"sampleStart\":0,\"sampleCount\":" << sample_count
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
  if (command == L"getcaps") return getcaps(dll_path, options);
  if (command == L"connect-preflight") return connect_preflight(dll_path, options);
  if (command == L"read-ram-probe") return read_ram_probe(dll_path, options);
  if (command == L"self-test") return self_test();
  if (command == L"hss-capture") return hss_capture(options);
  if (command == L"hss-smoke" || command == L"hss-benchmark") {
    error_json("HSS_START_READ_STOP_NOT_AUTHORIZED_YET", "connect-preflight must pass before enabling HSS Start/Read/Stop candidate calls", narrow(dll_path));
    return 0;
  }
  error_json("HSS_HELPER_UNKNOWN_COMMAND", "unknown command");
  return 0;
}
