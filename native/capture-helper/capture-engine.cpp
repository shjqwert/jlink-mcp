#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>

#include "capture-engine.h"
#include "parent-monitor.h"
#include "rsp.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace capture {
namespace {

class FakeRspServer {
 public:
  explicit FakeRspServer(bool failStop) : failStop_(failStop) {
    listener_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener_ == INVALID_SOCKET) throw std::runtime_error("Fake RSP listener creation failed");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    if (bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0 || listen(listener_, 1) != 0) throw std::runtime_error("Fake RSP listener bind failed");
    int length = sizeof(address);
    if (getsockname(listener_, reinterpret_cast<sockaddr*>(&address), &length) != 0) throw std::runtime_error("Fake RSP listener address failed");
    port_ = ntohs(address.sin_port);
    worker_ = std::jthread([this](std::stop_token) { serve(); });
  }

  ~FakeRspServer() {
    if (client_ != INVALID_SOCKET) { shutdown(client_, SD_BOTH); closesocket(client_); }
    if (listener_ != INVALID_SOCKET) { closesocket(listener_); }
  }

  [[nodiscard]] uint16_t port() const { return port_; }
  [[nodiscard]] uint32_t startWrites() const { return startWrites_.load(); }
  [[nodiscard]] uint32_t stopWrites() const { return stopWrites_.load(); }
  [[nodiscard]] uint32_t resets() const { return resets_.load(); }
  [[nodiscard]] bool noAckEnabled() const { return noAckMode_.load(); }

 private:
  SOCKET listener_ = INVALID_SOCKET;
  SOCKET client_ = INVALID_SOCKET;
  uint16_t port_ = 0;
  bool failStop_ = false;
  std::jthread worker_;
  std::array<uint8_t, 64> memory_{};
  std::atomic<uint32_t> startWrites_ = 0;
  std::atomic<uint32_t> stopWrites_ = 0;
  std::atomic<uint32_t> resets_ = 0;
  std::atomic<bool> noAckMode_ = false;
  bool noAckPending_ = false;
  bool monitorTerminalPending_ = false;

  void sendRaw(std::string_view data) {
    size_t sent = 0;
    while (sent < data.size()) {
      const int count = send(client_, data.data() + sent, static_cast<int>(data.size() - sent), 0);
      if (count <= 0) return;
      sent += static_cast<size_t>(count);
    }
  }

  void sendResponse(std::string_view payload) { sendRaw(rspPacket(payload)); }
  void sendBinaryResponse(std::string_view payload) { sendRaw(rspBinaryPacket(payload)); }

  void serve() {
    client_ = accept(listener_, nullptr, nullptr);
    if (client_ == INVALID_SOCKET) return;
    std::string input;
    char chunk[4096]{};
    while (true) {
      const int count = recv(client_, chunk, sizeof(chunk), 0);
      if (count <= 0) return;
      input.append(chunk, static_cast<size_t>(count));
      for (;;) {
        if (!input.empty() && (input[0] == '+' || input[0] == '-')) {
          const char acknowledgement = input[0];
          input.erase(0, 1);
          if (acknowledgement == '+' && noAckPending_) {
            noAckPending_ = false;
            noAckMode_.store(true);
          }
          if (acknowledgement == '+' && monitorTerminalPending_) {
            monitorTerminalPending_ = false;
            sendResponse("OK");
          }
          continue;
        }
        const size_t start = input.find('$');
        if (start == std::string::npos) { input.clear(); break; }
        if (start > 0) input.erase(0, start);
        const size_t hash = input.find('#', 1);
        if (hash == std::string::npos || input.size() < hash + 3U) break;
        const std::string payload = input.substr(1, hash - 1);
        const uint8_t expected = hexDecode(std::string_view(input).substr(hash + 1U, 2U))[0];
        input.erase(0, hash + 3U);
        if (expected != rspChecksum(payload)) { sendRaw("-"); continue; }
        if (!noAckMode_.load()) sendRaw("+");
        handle(payload);
      }
    }
  }

  void handle(const std::string& payload) {
    if (payload.starts_with("qSupported")) { sendResponse("PacketSize=4000;QStartNoAckMode+;binary-upload+"); return; }
    if (payload == "QStartNoAckMode") {
      noAckPending_ = true;
      sendResponse("OK");
      return;
    }
    if (payload.starts_with("qRcmd,")) {
      const auto bytes = hexDecode(std::string_view(payload).substr(6));
      const std::string command(reinterpret_cast<const char*>(bytes.data()), bytes.size());
      if (command == "status") {
        sendResponse("O" + hexEncode("Target is running; VTref=3.3V"));
        if (noAckMode_.load()) sendResponse("OK");
        else monitorTerminalPending_ = true;
        return;
      }
      if (command == "reset") {
        resets_.fetch_add(1);
        sendResponse("O" + hexEncode("reset"));
        if (noAckMode_.load()) sendResponse("OK");
        else monitorTerminalPending_ = true;
        return;
      }
      sendResponse("E01");
      return;
    }
    if (!payload.empty() && (payload[0] == 'm' || payload[0] == 'x')) {
      uint64_t address = 0;
      size_t length = 0;
      if (sscanf_s(payload.c_str() + 1, "%llx,%zx", &address, &length) != 2) { sendResponse("E02"); return; }
      if (address == 0xE000EDF0ULL && length == 4U) {
        if (payload[0] == 'x') sendBinaryResponse(std::string("b\x01\x00\x01\x01", 5));
        else sendResponse("01000101");
        return;
      }
      if (address < 0x20000000ULL || address + length > 0x20000000ULL + memory_.size()) { sendResponse("E02"); return; }
      const size_t offset = static_cast<size_t>(address - 0x20000000ULL);
      const std::string_view data(reinterpret_cast<const char*>(memory_.data() + offset), length);
      if (payload[0] == 'x') sendBinaryResponse("b" + std::string(data));
      else sendResponse(hexEncode(data));
      return;
    }
    if (!payload.empty() && payload[0] == 'M') {
      unsigned long long address = 0;
      size_t length = 0;
      int dataOffset = 0;
      if (sscanf_s(payload.c_str() + 1, "%llx,%zx:%n", &address, &length, &dataOffset) < 2 || dataOffset <= 0) { sendResponse("E03"); return; }
      const auto data = hexDecode(std::string_view(payload).substr(static_cast<size_t>(dataOffset) + 1U));
      if (address != 0x20000004ULL || data.size() != length || length != 4U) { sendResponse("E04"); return; }
      const uint32_t value = static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8U) | (static_cast<uint32_t>(data[2]) << 16U) | (static_cast<uint32_t>(data[3]) << 24U);
      if (value == 1U) {
        startWrites_.fetch_add(1);
        memory_[8] = 1;
      } else {
        stopWrites_.fetch_add(1);
        if (failStop_) { sendResponse("E05"); return; }
        memory_[8] = 0;
      }
      std::copy(data.begin(), data.end(), memory_.begin() + 4);
      sendResponse("OK");
      return;
    }
    sendResponse("");
  }
};

enum class ScalarKind : uint32_t { Int8 = 1, Uint8, Int16, Uint16, Int32, Uint32, Float32 };
enum class TerminalState : uint32_t { None = 0, Completed = 1, Stopped = 2, Failed = 3 };

struct Symbol {
  std::string name;
  std::string alias;
  std::string unit;
  uint64_t address = 0;
  uint32_t size = 0;
  ScalarKind type = ScalarKind::Uint32;
};

struct MemoryRange {
  uint64_t start = 0;
  uint64_t end = 0;
};

struct PlanRange {
  uint64_t start = 0;
  uint32_t length = 0;
};

struct ReadPlan {
  std::vector<PlanRange> ranges;
  double minUs = 0;
  double meanUs = 0;
  double maxUs = 0;
  double p999Us = 0;
  std::string failure;
};

#pragma pack(push, 1)
struct BinaryHeader {
  char magic[4] = {'J', 'L', 'C', 'P'};
  uint32_t version = 1;
  uint32_t headerSize = sizeof(BinaryHeader);
  int64_t qpcFrequency = 0;
  uint32_t symbolCount = 0;
  uint32_t frameSize = 0;
  uint64_t frameCount = 0;
  uint64_t eventCount = 0;
  uint32_t terminalState = 0;
  uint32_t reserved = 0;
};

struct BinarySymbol {
  char name[256]{};
  char alias[128]{};
  char unit[64]{};
  uint64_t address = 0;
  uint32_t size = 0;
  uint32_t type = 0;
};

struct BinaryFrame {
  uint64_t index = 0;
  int64_t scheduledQpc = 0;
  int64_t readStartQpc = 0;
  int64_t readEndQpc = 0;
  int64_t readMidpointQpc = 0;
  int64_t readDurationQpc = 0;
  uint32_t flags = 0;
  uint32_t valid = 0;
  uint32_t rawValues[32]{};
};

struct BinaryEvent {
  int64_t qpc = 0;
  uint32_t success = 0;
  char type[48]{};
  char detail[256]{};
};
#pragma pack(pop)

static_assert(sizeof(BinaryFrame) == 184);
static_assert(sizeof(BinaryHeader) == 52);
static_assert(sizeof(BinarySymbol) == 464);
static_assert(sizeof(BinaryEvent) == 316);

template <size_t Size>
void copyText(char (&destination)[Size], std::string_view text) {
  const size_t count = std::min(text.size(), Size - 1U);
  std::copy_n(text.data(), count, destination);
  destination[count] = '\0';
}

class CaptureBuffer {
 public:
  CaptureBuffer() = default;
  ~CaptureBuffer() { release(); }
  CaptureBuffer(const CaptureBuffer&) = delete;
  CaptureBuffer& operator=(const CaptureBuffer&) = delete;

  void allocate(size_t frameCapacity, size_t eventCapacity) {
    release();
    if (frameCapacity == 0 || frameCapacity > 2'000'000U || eventCapacity == 0 || eventCapacity > 65'536U) throw std::runtime_error("Capture allocation bounds rejected");
    frameCapacity_ = frameCapacity;
    eventCapacity_ = eventCapacity;
    bytes_ = frameCapacity * sizeof(BinaryFrame) + eventCapacity * sizeof(BinaryEvent);
    memory_ = VirtualAlloc(nullptr, bytes_, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (memory_ == nullptr) throw std::runtime_error("VirtualAlloc failed for capture buffer");
    if (!VirtualLock(memory_, bytes_)) {
      release();
      throw std::runtime_error("VirtualLock failed for capture buffer");
    }
    frames_ = static_cast<BinaryFrame*>(memory_);
    events_ = reinterpret_cast<BinaryEvent*>(frames_ + frameCapacity_);
  }

  void release() noexcept {
    if (memory_ != nullptr) {
      (void)VirtualUnlock(memory_, bytes_);
      (void)VirtualFree(memory_, 0, MEM_RELEASE);
    }
    memory_ = nullptr;
    frames_ = nullptr;
    events_ = nullptr;
    bytes_ = 0;
    frameCapacity_ = 0;
    eventCapacity_ = 0;
    frameCount_ = 0;
    eventCount_ = 0;
  }

  [[nodiscard]] BinaryFrame& addFrame() {
    if (frameCount_ >= frameCapacity_) throw std::runtime_error("Capture frame buffer exhausted");
    BinaryFrame& frame = frames_[frameCount_++];
    frame = {};
    return frame;
  }

  void addEvent(int64_t qpc, std::string_view type, bool success, std::string_view detail) {
    const bool critical = type == "termination" || type == "reset" || type == "read_failure_threshold" || type == "control_timeout" || type == "control_error";
    if (!critical && eventCount_ + 16U >= eventCapacity_) return;
    if (eventCount_ >= eventCapacity_) return;
    BinaryEvent& event = events_[eventCount_++];
    event = {};
    event.qpc = qpc;
    event.success = success ? 1U : 0U;
    copyText(event.type, type);
    copyText(event.detail, detail);
  }

  [[nodiscard]] BinaryFrame* frames() const { return frames_; }
  [[nodiscard]] BinaryEvent* events() const { return events_; }
  [[nodiscard]] size_t frameCount() const { return frameCount_; }
  [[nodiscard]] size_t eventCount() const { return eventCount_; }

 private:
  void* memory_ = nullptr;
  BinaryFrame* frames_ = nullptr;
  BinaryEvent* events_ = nullptr;
  size_t bytes_ = 0;
  size_t frameCapacity_ = 0;
  size_t eventCapacity_ = 0;
  size_t frameCount_ = 0;
  size_t eventCount_ = 0;
};

int64_t qpcNow() {
  LARGE_INTEGER value{};
  QueryPerformanceCounter(&value);
  return value.QuadPart;
}

int64_t qpcFrequency() {
  LARGE_INTEGER value{};
  QueryPerformanceFrequency(&value);
  return value.QuadPart;
}

double percentile(std::vector<double> values, double percentileValue) {
  if (values.empty()) throw std::runtime_error("Cannot calculate percentile of empty data");
  std::sort(values.begin(), values.end());
  const size_t index = std::min(values.size() - 1U, static_cast<size_t>(std::ceil(percentileValue * static_cast<double>(values.size()))) - 1U);
  return values[index];
}

uint64_t missedPeriods(int64_t now, int64_t deadline, int64_t period) {
  return now >= deadline + period ? static_cast<uint64_t>((now - deadline) / period) : 0U;
}

bool readFailureThreshold(uint32_t consecutiveFailures) {
  return consecutiveFailures >= 3U;
}

bool shouldResetAfterStopFailure(bool captureStarted, bool resetEnabled, bool resetAlreadyAttempted) {
  return captureStarted && resetEnabled && !resetAlreadyAttempted;
}

bool dhcsrConfirmsRunning(uint32_t value) {
  constexpr uint32_t cDebugEn = 1U;
  constexpr uint32_t sHalt = 1U << 17U;
  constexpr uint32_t sResetSt = 1U << 25U;
  return value != UINT32_MAX && (value & cDebugEn) != 0U && (value & (sHalt | sResetSt)) == 0U;
}

bool planPasses(const ReadPlan& plan, uint32_t rateHz, double limitUs = 100.0) {
  return plan.failure.empty() && plan.p999Us <= limitUs && plan.p999Us <= 1'000'000.0 / rateHz;
}

ScalarKind parseScalarKind(std::string_view type) {
  if (type == "int8") return ScalarKind::Int8;
  if (type == "uint8") return ScalarKind::Uint8;
  if (type == "int16") return ScalarKind::Int16;
  if (type == "uint16") return ScalarKind::Uint16;
  if (type == "int32") return ScalarKind::Int32;
  if (type == "uint32") return ScalarKind::Uint32;
  if (type == "float32") return ScalarKind::Float32;
  throw std::runtime_error("Unsupported scalar type");
}

uint32_t scalarSize(ScalarKind type) {
  if (type == ScalarKind::Int8 || type == ScalarKind::Uint8) return 1;
  if (type == ScalarKind::Int16 || type == ScalarKind::Uint16) return 2;
  return 4;
}

bool insideRange(uint64_t start, uint64_t end, const std::vector<MemoryRange>& ranges) {
  return std::any_of(ranges.begin(), ranges.end(), [start, end](const MemoryRange& range) { return start >= range.start && end <= range.end; });
}

std::vector<ReadPlan> buildReadPlans(const std::vector<Symbol>& symbols, const std::vector<MemoryRange>& ramRanges) {
  std::vector<ReadPlan> plans;
  for (const uint64_t maxGap : {0ULL, 4ULL, 16ULL, 64ULL, 256ULL}) {
    ReadPlan plan;
    for (const Symbol& symbol : symbols) {
      const uint64_t end = symbol.address + symbol.size;
      if (!insideRange(symbol.address, end, ramRanges)) throw std::runtime_error("Symbol is outside validated RAM");
      if (!plan.ranges.empty()) {
        PlanRange& previous = plan.ranges.back();
        const uint64_t previousEnd = previous.start + previous.length;
        if (symbol.address >= previousEnd && symbol.address - previousEnd <= maxGap && insideRange(previous.start, end, ramRanges)) {
          previous.length = static_cast<uint32_t>(end - previous.start);
          continue;
        }
      }
      plan.ranges.push_back({symbol.address, symbol.size});
    }
    if (plans.empty() || plans.back().ranges.size() != plan.ranges.size() || !std::equal(plan.ranges.begin(), plan.ranges.end(), plans.back().ranges.begin(), [](const PlanRange& left, const PlanRange& right) { return left.start == right.start && left.length == right.length; })) {
      plans.push_back(std::move(plan));
    }
  }
  return plans;
}

std::wstring utf8Path(std::string_view value) {
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw std::runtime_error("Invalid UTF-8 path");
  std::wstring result(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size) != size) throw std::runtime_error("Invalid UTF-8 path");
  return result;
}

std::string utf8Text(std::wstring_view value) {
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw std::runtime_error("Invalid UTF-16 text");
  std::string result(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size) throw std::runtime_error("Invalid UTF-16 text");
  return result;
}

void writeAll(HANDLE file, const void* data, size_t size) {
  const auto* bytes = static_cast<const uint8_t*>(data);
  size_t written = 0;
  while (written < size) {
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(size - written, MAXDWORD));
    DWORD count = 0;
    if (!WriteFile(file, bytes + written, chunk, &count, nullptr) || count == 0) throw std::runtime_error("Capture artifact write failed");
    written += count;
  }
}

uint64_t jsonUnsigned(const Json& value, std::string_view field, uint64_t minimum, uint64_t maximum) {
  const double number = value.number();
  if (!std::isfinite(number) || std::floor(number) != number || number < static_cast<double>(minimum) || number > static_cast<double>(maximum)) {
    throw std::runtime_error(std::string(field) + " is outside the allowed integer range");
  }
  return static_cast<uint64_t>(number);
}

std::string optionalString(const Json& objectValue, std::string_view key) {
  const Json* value = objectValue.find(key);
  return value == nullptr ? std::string{} : value->string();
}

struct Condition {
  Symbol symbol;
  std::string operation;
  double value = 0;
};

struct ControlCommand {
  Symbol target;
  double value = 0;
  Condition verify;
  uint32_t timeoutMs = 0;
};

Symbol parseSymbol(const Json& value) {
  Symbol symbol;
  symbol.name = value.at("name").string();
  symbol.alias = optionalString(value, "alias");
  symbol.unit = optionalString(value, "unit");
  symbol.address = jsonUnsigned(value.at("address"), "symbol address", 0, 0xFFFFFFFFULL);
  symbol.size = static_cast<uint32_t>(jsonUnsigned(value.at("size"), "symbol size", 1, 4));
  symbol.type = parseScalarKind(value.at("type").string());
  if (symbol.size != scalarSize(symbol.type) || symbol.address % symbol.size != 0U) throw std::runtime_error("Symbol type, size, or alignment mismatch");
  return symbol;
}

Condition parseCondition(const Json& value) {
  Condition condition;
  condition.symbol = parseSymbol(value.at("symbol"));
  condition.operation = value.at("operator").string();
  if (condition.operation != "eq" && condition.operation != "ne" && condition.operation != "lt" && condition.operation != "lte" && condition.operation != "gt" && condition.operation != "gte") throw std::runtime_error("Unsupported verification operator");
  condition.value = value.at("value").number();
  return condition;
}

ControlCommand parseControl(const Json& value) {
  ControlCommand command;
  command.target = parseSymbol(value.at("target"));
  command.value = value.at("value").number();
  command.verify = parseCondition(value.at("verify"));
  command.timeoutMs = static_cast<uint32_t>(jsonUnsigned(value.at("timeoutMs"), "control timeout", 1, 10000));
  return command;
}

std::vector<uint8_t> encodeScalar(ScalarKind type, double value) {
  const uint32_t size = scalarSize(type);
  std::vector<uint8_t> bytes(size);
  uint32_t raw = 0;
  switch (type) {
    case ScalarKind::Int8:
      if (std::floor(value) != value || value < -128 || value > 127) throw std::runtime_error("int8 control value is out of range");
      raw = static_cast<uint8_t>(static_cast<int8_t>(value));
      break;
    case ScalarKind::Uint8:
      if (std::floor(value) != value || value < 0 || value > 255) throw std::runtime_error("uint8 control value is out of range");
      raw = static_cast<uint8_t>(value);
      break;
    case ScalarKind::Int16:
      if (std::floor(value) != value || value < -32768 || value > 32767) throw std::runtime_error("int16 control value is out of range");
      raw = static_cast<uint16_t>(static_cast<int16_t>(value));
      break;
    case ScalarKind::Uint16:
      if (std::floor(value) != value || value < 0 || value > 65535) throw std::runtime_error("uint16 control value is out of range");
      raw = static_cast<uint16_t>(value);
      break;
    case ScalarKind::Int32:
      if (std::floor(value) != value || value < -2147483648.0 || value > 2147483647.0) throw std::runtime_error("int32 control value is out of range");
      raw = static_cast<uint32_t>(static_cast<int32_t>(value));
      break;
    case ScalarKind::Uint32:
      if (std::floor(value) != value || value < 0 || value > 4294967295.0) throw std::runtime_error("uint32 control value is out of range");
      raw = static_cast<uint32_t>(value);
      break;
    case ScalarKind::Float32: {
      const float floatValue = static_cast<float>(value);
      static_assert(sizeof(floatValue) == sizeof(raw));
      std::memcpy(&raw, &floatValue, sizeof(raw));
      break;
    }
  }
  for (uint32_t index = 0; index < size; ++index) bytes[index] = static_cast<uint8_t>((raw >> (index * 8U)) & 0xFFU);
  return bytes;
}

uint32_t rawScalar(const std::vector<uint8_t>& bytes) {
  uint32_t raw = 0;
  for (size_t index = 0; index < bytes.size(); ++index) raw |= static_cast<uint32_t>(bytes[index]) << (index * 8U);
  return raw;
}

double decodeScalar(ScalarKind type, uint32_t raw) {
  switch (type) {
    case ScalarKind::Int8: return static_cast<int8_t>(raw & 0xFFU);
    case ScalarKind::Uint8: return raw & 0xFFU;
    case ScalarKind::Int16: return static_cast<int16_t>(raw & 0xFFFFU);
    case ScalarKind::Uint16: return raw & 0xFFFFU;
    case ScalarKind::Int32: return static_cast<int32_t>(raw);
    case ScalarKind::Uint32: return raw;
    case ScalarKind::Float32: {
      float value = 0;
      std::memcpy(&value, &raw, sizeof(value));
      return value;
    }
  }
  return 0;
}

bool compareValue(double actual, const Condition& condition) {
  switch (condition.operation[0]) {
    case 'e': return actual == condition.value;
    case 'n': return actual != condition.value;
    case 'l': return condition.operation == "lt" ? actual < condition.value : actual <= condition.value;
    case 'g': return condition.operation == "gt" ? actual > condition.value : actual >= condition.value;
    default: return false;
  }
}

void requireFlashMatch(const std::vector<uint8_t>& expected, const std::vector<uint8_t>& actual, uint64_t address = 0) {
  if (expected == actual) return;
  const auto different = std::mismatch(expected.begin(), expected.end(), actual.begin(), actual.end());
  const size_t mismatch = static_cast<size_t>(std::distance(expected.begin(), different.first));
  std::ostringstream message;
  message << "Target Flash does not match the selected ELF at 0x" << std::hex << address + mismatch;
  if (different.first != expected.end() && different.second != actual.end()) {
    message << " expected=0x" << static_cast<unsigned>(*different.first) << " actual=0x" << static_cast<unsigned>(*different.second);
  }
  throw std::runtime_error(message.str());
}

uint16_t checkedPort(const Json& value) {
  const double number = value.number();
  if (std::floor(number) != number || number < 1 || number > 65535) throw std::runtime_error("RSP port must be 1..65535");
  return static_cast<uint16_t>(number);
}



}  // namespace

class CaptureEngine::Impl {
 public:
  using Notify = std::function<void(std::string, Json)>;

  explicit Impl(Notify notify, uint32_t calibrationSamples = 1000, double calibrationLimitUs = 100.0)
      : notify_(std::move(notify)), calibrationSamples_(calibrationSamples), calibrationLimitUs_(calibrationLimitUs) {}
  ~Impl() { close(); }
  Impl(const Impl&) = delete;
  Impl& operator=(const Impl&) = delete;

  Json prepare(const Json& payload) {
    std::lock_guard lifecycle(lifecycleMutex_);
    if (state_ != "idle") throw std::runtime_error("Capture helper is not idle");
    state_ = "preparing";
    try {
      rateHz_ = static_cast<uint32_t>(jsonUnsigned(payload.at("rateHz"), "rateHz", 1, 1000));
      durationSec_ = static_cast<uint32_t>(jsonUnsigned(payload.at("durationSec"), "durationSec", 1, 600));
      preStartMs_ = static_cast<uint32_t>(jsonUnsigned(payload.at("preStartMs"), "preStartMs", 0, 5000));
      postStopMs_ = static_cast<uint32_t>(jsonUnsigned(payload.at("postStopMs"), "postStopMs", 0, 10000));
      resetOnFailure_ = payload.at("resetOnFailure").boolean();
      outputFile_ = payload.at("outputFile").string();
      if (!std::filesystem::path(utf8Path(outputFile_)).is_absolute()) throw std::runtime_error("outputFile must be absolute");

      symbols_.clear();
      for (const Json& symbol : payload.at("symbols").array()) symbols_.push_back(parseSymbol(symbol));
      if (symbols_.empty() || symbols_.size() > 32U) throw std::runtime_error("symbols must contain 1..32 entries");
      std::sort(symbols_.begin(), symbols_.end(), [](const Symbol& left, const Symbol& right) { return left.address < right.address; });
      for (size_t index = 1; index < symbols_.size(); ++index) {
        if (symbols_[index - 1U].address + symbols_[index - 1U].size > symbols_[index].address) throw std::runtime_error("Capture symbols overlap");
      }

      ramRanges_.clear();
      for (const Json& range : payload.at("ramRanges").array()) {
        const uint64_t start = jsonUnsigned(range.at("start"), "RAM start", 0, 0xFFFFFFFFULL);
        const uint64_t end = jsonUnsigned(range.at("end"), "RAM end", 1, 0x1'0000'0000ULL);
        if (end <= start) throw std::runtime_error("Invalid RAM range");
        ramRanges_.push_back({start, end});
      }
      if (ramRanges_.empty()) throw std::runtime_error("At least one validated RAM range is required");

      startCommand_ = parseControl(payload.at("control").at("start"));
      stopCommand_ = parseControl(payload.at("control").at("stop"));
      validateControlSymbol(startCommand_.target);
      validateControlSymbol(startCommand_.verify.symbol);
      validateControlSymbol(stopCommand_.target);
      validateControlSymbol(stopCommand_.verify.symbol);

      // ponytail: ten seconds covers Agent dispatch jitter; use a ring buffer only if real workflows exceed it.
      const uint64_t seconds = static_cast<uint64_t>(durationSec_) + (preStartMs_ + postStopMs_ + 999U) / 1000U + 10U;
      const size_t frameCapacity = static_cast<size_t>(seconds * rateHz_);
      const SIZE_T desired = static_cast<SIZE_T>(frameCapacity * sizeof(BinaryFrame) + 16U * 1024U * 1024U);
      (void)SetProcessWorkingSetSize(GetCurrentProcess(), desired, desired + 16U * 1024U * 1024U);
      buffer_.allocate(frameCapacity, 4096);

      rsp_.connectTo(payload.at("host").string(), checkedPort(payload.at("port")), 3000);
      capabilities_ = rsp_.negotiate();
      requireRunning("before background reads", true);
      verifyFlash(payload.at("flashSections").array());
      rsp_.setIoTimeout(50);

      if (!SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS)) throw std::runtime_error("Failed to set HIGH_PRIORITY_CLASS for calibration");
      if (!SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST)) throw std::runtime_error("Failed to set calibration thread priority");
      auto plans = buildReadPlans(symbols_, ramRanges_);
      for (ReadPlan& plan : plans) calibrate(plan);
      const auto selected = std::min_element(plans.begin(), plans.end(), [this](const ReadPlan& left, const ReadPlan& right) {
        const bool leftPass = planPasses(left, rateHz_, calibrationLimitUs_);
        const bool rightPass = planPasses(right, rateHz_, calibrationLimitUs_);
        if (leftPass != rightPass) return leftPass;
        return left.meanUs < right.meanUs;
      });
      if (selected == plans.end() || !planPasses(*selected, rateHz_, calibrationLimitUs_)) {
        std::ostringstream evidence;
        evidence << "Calibration failed requested rate or 100 us P99.9 limit:";
        for (const ReadPlan& candidate : plans) {
          evidence << " ranges=" << candidate.ranges.size();
          if (!candidate.failure.empty()) evidence << " failure=" << candidate.failure << ";";
          else evidence << " min=" << candidate.minUs << "us mean=" << candidate.meanUs << "us max=" << candidate.maxUs << "us p99.9=" << candidate.p999Us << "us;";
        }
        throw std::runtime_error(evidence.str());
      }
      plan_ = *selected;
      requireRunning("after background reads");
      state_ = "armed";
      addEvent("prepared", true, "background reads and calibration passed");
      return Json(object({
        {"state", Json(state_)},
        {"capabilities", Json(capabilities_)},
        {"targetStatus", Json(lastTargetStatus_)},
        {"qpcFrequency", Json(static_cast<double>(frequency_))},
        {"planRanges", Json(static_cast<double>(plan_.ranges.size()))},
        {"calibration", Json(object({
          {"minUs", Json(plan_.minUs)}, {"meanUs", Json(plan_.meanUs)}, {"maxUs", Json(plan_.maxUs)}, {"p999Us", Json(plan_.p999Us)},
        }))},
        {"flashReadRetries", Json(static_cast<double>(flashReadRetries_))},
      }));
    } catch (...) {
      state_ = "failed";
      rsp_.close();
      buffer_.release();
      throw;
    }
  }

  Json start() {
    {
      std::lock_guard lifecycle(lifecycleMutex_);
      if (state_ != "armed") throw std::runtime_error("capture_start requires armed state");
      if (!SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS)) throw std::runtime_error("Failed to set HIGH_PRIORITY_CLASS");
      stopRequested_.store(false);
      captureStartQpc_ = qpcNow();
      captureEverStarted_.store(true);
      state_ = "capturing";
      addEvent("capture_start", true, "sampling started");
      worker_ = std::jthread([this](std::stop_token) { sampleLoop(); });
    }
    return status();
  }

  Json abortPreparation(std::string reason) {
    std::lock_guard lifecycle(lifecycleMutex_);
    if (state_ != "armed" && state_ != "preparing") throw std::runtime_error("abort_prepare is only valid before capture starts");
    state_ = "failed";
    terminationReason_ = std::move(reason);
    rsp_.close();
    buffer_.release();
    return Json(object({{"state", Json(state_)}, {"terminationReason", Json(terminationReason_)}}));
  }

  Json setMetadata(const Json& metadata) {
    std::lock_guard lifecycle(lifecycleMutex_);
    if (state_ != "armed") throw std::runtime_error("metadata is only accepted for an armed session");
    if (metadata.at("version").number() != 1.0 || metadata.at("sessionId").string().empty() || metadata.at("elfSha256").string().size() != 64U) throw std::runtime_error("Invalid capture metadata identity");
    metadata_ = metadata.object();
    return Json(object({{"accepted", Json(true)}}));
  }

  Json control(std::string_view command) {
    if (command == "start") {
      {
        std::lock_guard lifecycle(lifecycleMutex_);
        if (state_ != "capturing") throw std::runtime_error("Motor start requires capturing state");
        if (motorRunning_) throw std::runtime_error("Motor is already verified running");
      }
      const int64_t baselineEnd = captureStartQpc_ + static_cast<int64_t>(preStartMs_) * frequency_ / 1000;
      while (qpcNow() < baselineEnd && !stopRequested_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
      {
        std::scoped_lock lock(lifecycleMutex_, bufferMutex_);
        const size_t requiredFrames = static_cast<size_t>((static_cast<uint64_t>(preStartMs_) * rateHz_ + 999U) / 1000U);
        if (state_ != "capturing" || stopRequested_.load()) throw std::runtime_error("Capture is no longer running; motor start is forbidden");
        if (buffer_.frameCount() < requiredFrames) throw std::runtime_error("Valid pre-start baseline frames were not collected; motor start is forbidden");
      }
      addEvent("control_request", true, "start");
      bool verified = false;
      {
        std::lock_guard controlLock(controlMutex_);
        verified = executeControl(startCommand_, "start");
        if (verified) {
          motorRunning_ = true;
          durationStartQpc_.store(qpcNow());
          addEvent("motor_state", true, "running");
        }
      }
      if (!verified) {
        finishFromCaller(TerminalState::Failed, "start_verification_failed", true);
        throw std::runtime_error("Start verification failed; safety shutdown completed");
      }
      return status();
    }
    if (command == "stop") {
      std::string current;
      {
        std::lock_guard lifecycle(lifecycleMutex_);
        if (state_ != "armed" && state_ != "capturing") throw std::runtime_error("Motor stop requires armed or capturing state");
        current = state_;
      }
      addEvent("control_request", true, "stop");
      bool verified = false;
      {
        std::lock_guard controlLock(controlMutex_);
        verified = executeControl(stopCommand_, "stop");
      }
      if (!verified) {
        attemptResetAfterUnverifiedStop();
        finishFromCaller(TerminalState::Failed, "stop_verification_failed", false);
        throw std::runtime_error("Stop verification failed; safety shutdown completed");
      }
      motorRunning_ = false;
      addEvent("motor_state", true, "stopped");
      if (current == "capturing") {
        std::this_thread::sleep_for(std::chrono::milliseconds(postStopMs_));
        finishFromCaller(TerminalState::Stopped, "control_stop", false);
      }
      return status();
    }
    throw std::runtime_error("Only allowlisted start or stop is accepted");
  }

  Json stop() {
    std::string current;
    {
      std::lock_guard lifecycle(lifecycleMutex_);
      current = state_;
      if (current != "armed" && current != "capturing") throw std::runtime_error("capture_stop requires armed or capturing state");
    }
    if (current == "armed" || motorRunning_) {
      bool verified = false;
      {
        std::lock_guard controlLock(controlMutex_);
        verified = executeControl(stopCommand_, "stop");
      }
      if (!verified) {
        attemptResetAfterUnverifiedStop();
        finishFromCaller(TerminalState::Failed, "stop_verification_failed", false);
        throw std::runtime_error("Stop verification failed; safety shutdown completed");
      }
      motorRunning_ = false;
      addEvent("motor_state", true, "stopped");
      if (current == "capturing") std::this_thread::sleep_for(std::chrono::milliseconds(postStopMs_));
    }
    finishFromCaller(TerminalState::Stopped, "capture_stop", false);
    return status();
  }

  Json status() const {
    std::scoped_lock lock(lifecycleMutex_, bufferMutex_);
    Json::Object result = object({
      {"state", Json(state_)},
      {"frames", Json(static_cast<double>(buffer_.frameCount()))},
      {"events", Json(static_cast<double>(buffer_.eventCount()))},
      {"missedDeadlines", Json(static_cast<double>(missedDeadlines_.load()))},
      {"readFailures", Json(static_cast<double>(readFailures_.load()))},
      {"motorRunning", Json(motorRunning_.load())},
      {"resetAttempted", Json(resetAttempted_.load())},
      {"outputFile", Json(outputFile_)},
      {"terminationReason", Json(terminationReason_)},
    });
    if (plan_.p999Us > 0) result.emplace("calibrationP999Us", Json(plan_.p999Us));
    return Json(std::move(result));
  }

  void parentLost() noexcept {
    try { finishFromCaller(TerminalState::Failed, "parent_or_ipc_lost", true); } catch (...) { }
  }

  void close() noexcept {
    try {
      stopRequested_.store(true);
      if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
      rsp_.close();
    } catch (...) { }
  }

 private:
  mutable std::mutex lifecycleMutex_;
  std::mutex rspMutex_;
  std::mutex controlMutex_;
  mutable std::mutex bufferMutex_;
  Notify notify_;
  RspClient rsp_;
  CaptureBuffer buffer_;
  std::jthread worker_;
  std::vector<Symbol> symbols_;
  std::vector<MemoryRange> ramRanges_;
  ReadPlan plan_;
  ControlCommand startCommand_;
  ControlCommand stopCommand_;
  std::string state_ = "idle";
  std::string outputFile_;
  std::string capabilities_;
  std::string lastTargetStatus_;
  std::string terminationReason_;
  Json::Object metadata_;
  uint32_t rateHz_ = 0;
  uint32_t durationSec_ = 0;
  uint32_t preStartMs_ = 0;
  uint32_t postStopMs_ = 0;
  bool resetOnFailure_ = false;
  const int64_t frequency_ = qpcFrequency();
  uint32_t calibrationSamples_ = 1000;
  double calibrationLimitUs_ = 100.0;
  int64_t captureStartQpc_ = 0;
  std::atomic<int64_t> durationStartQpc_ = 0;
  std::atomic<bool> stopRequested_ = false;
  std::atomic<bool> motorRunning_ = false;
  std::atomic<bool> resetAttempted_ = false;
  std::atomic<bool> captureEverStarted_ = false;
  std::atomic<uint64_t> missedDeadlines_ = 0;
  std::atomic<uint64_t> readFailures_ = 0;
  uint64_t flashReadRetries_ = 0;

  void validateControlSymbol(const Symbol& symbol) const {
    if (!insideRange(symbol.address, symbol.address + symbol.size, ramRanges_)) throw std::runtime_error("Control selector is outside validated writable RAM");
  }

  void addEvent(std::string_view type, bool success, std::string_view detail) {
    std::lock_guard lock(bufferMutex_);
    buffer_.addEvent(qpcNow(), type, success, detail);
  }

  uint32_t readDhcsr() {
    std::vector<uint8_t> bytes;
    {
      std::lock_guard lock(rspMutex_);
      bytes = rsp_.readMemory(0xE000EDF0ULL, 4U);
    }
    return static_cast<uint32_t>(bytes[0])
      | (static_cast<uint32_t>(bytes[1]) << 8U)
      | (static_cast<uint32_t>(bytes[2]) << 16U)
      | (static_cast<uint32_t>(bytes[3]) << 24U);
  }

  void requireRunning(std::string_view phase, bool clearStaleReset = false) {
    if (clearStaleReset) (void)readDhcsr();
    const uint32_t value = readDhcsr();
    std::ostringstream status;
    status << "DHCSR=0x" << std::hex << std::setw(8) << std::setfill('0') << value;
    lastTargetStatus_ = status.str();
    if (!dhcsrConfirmsRunning(value)) {
      throw std::runtime_error("Target running state is not confirmed " + std::string(phase) + ": " + lastTargetStatus_);
    }
  }

  void verifyFlash(const Json::Array& sections) {
    flashReadRetries_ = 0;
    for (const Json& section : sections) {
      const uint64_t address = jsonUnsigned(section.at("address"), "Flash address", 0, 0xFFFFFFFFULL);
      const std::vector<uint8_t> expected = hexDecode(section.at("dataHex").string());
      for (size_t offset = 0; offset < expected.size(); offset += 256U) {
        const size_t size = std::min<size_t>(256U, expected.size() - offset);
        const std::vector<uint8_t> expectedChunk(expected.begin() + static_cast<std::ptrdiff_t>(offset), expected.begin() + static_cast<std::ptrdiff_t>(offset + size));
        uint32_t matches = 0;
        std::vector<uint8_t> actual;
        for (uint32_t attempt = 0; attempt < 4U && matches < 2U; ++attempt) {
          {
            std::lock_guard lock(rspMutex_);
            actual = rsp_.readMemory(address + offset, size);
          }
          if (actual == expectedChunk) ++matches;
          if (attempt > 1U) ++flashReadRetries_;
        }
        if (matches < 2U) {
          if (actual == expectedChunk) {
            std::ostringstream message;
            message << "Target Flash reads were not repeatable at 0x" << std::hex << address + offset;
            throw std::runtime_error(message.str());
          }
          requireFlashMatch(expectedChunk, actual, address + offset);
        }
      }
    }
  }

  void readPlan(uint32_t* rawValues, int64_t& start, int64_t& end) {
    std::vector<std::pair<PlanRange, std::vector<uint8_t>>> reads;
    reads.reserve(plan_.ranges.size());
    start = qpcNow();
    for (const PlanRange& range : plan_.ranges) reads.emplace_back(range, rsp_.readMemory(range.start, range.length));
    end = qpcNow();
    for (size_t symbolIndex = 0; symbolIndex < symbols_.size(); ++symbolIndex) {
      const Symbol& symbol = symbols_[symbolIndex];
      const auto found = std::find_if(reads.begin(), reads.end(), [&symbol](const auto& read) { return symbol.address >= read.first.start && symbol.address + symbol.size <= read.first.start + read.first.length; });
      if (found == reads.end()) throw std::runtime_error("Read plan does not cover symbol");
      const size_t offset = static_cast<size_t>(symbol.address - found->first.start);
      rawValues[symbolIndex] = rawScalar(std::vector<uint8_t>(found->second.begin() + static_cast<std::ptrdiff_t>(offset), found->second.begin() + static_cast<std::ptrdiff_t>(offset + symbol.size)));
    }
  }

  void calibrate(ReadPlan& plan) {
    const ReadPlan previous = plan_;
    plan_ = plan;
    std::vector<double> windows;
    windows.reserve(calibrationSamples_);
    uint32_t raw[32]{};
    const int64_t period = frequency_ / rateHz_;
    int64_t deadline = qpcNow();
    try {
      for (uint32_t sample = 0; sample < calibrationSamples_; ++sample) {
        if (sample > 0U) {
          deadline += period;
          while (qpcNow() < deadline) {
            const int64_t remaining = deadline - qpcNow();
            if (remaining > frequency_ / 500) std::this_thread::sleep_for(std::chrono::milliseconds(1));
            else YieldProcessor();
          }
        }
        int64_t start = 0;
        int64_t end = 0;
        {
          std::lock_guard lock(rspMutex_);
          readPlan(raw, start, end);
        }
        windows.push_back(static_cast<double>(end - start) * 1'000'000.0 / frequency_);
      }
    } catch (const std::exception& error) {
      plan.failure = error.what();
      plan_ = previous;
      return;
    }
    plan.minUs = *std::min_element(windows.begin(), windows.end());
    plan.maxUs = *std::max_element(windows.begin(), windows.end());
    plan.meanUs = std::accumulate(windows.begin(), windows.end(), 0.0) / windows.size();
    plan.p999Us = percentile(windows, 0.999);
    plan_ = previous;
  }

  bool executeControl(const ControlCommand& command, std::string_view name) {
    try {
      {
        std::lock_guard lock(rspMutex_);
        rsp_.writeMemory(command.target.address, encodeScalar(command.target.type, command.value));
      }
      addEvent("control_write", true, name);
      const int64_t deadline = qpcNow() + static_cast<int64_t>(command.timeoutMs) * frequency_ / 1000;
      while (qpcNow() <= deadline) {
        std::vector<uint8_t> bytes;
        {
          std::lock_guard lock(rspMutex_);
          bytes = rsp_.readMemory(command.verify.symbol.address, command.verify.symbol.size);
        }
        const double actual = decodeScalar(command.verify.symbol.type, rawScalar(bytes));
        if (compareValue(actual, command.verify)) {
          addEvent("control_verify", true, name);
          return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      addEvent("control_timeout", false, name);
      return false;
    } catch (const std::exception& error) {
      addEvent("control_error", false, std::string(name) + ": " + error.what());
      return false;
    }
  }

  bool safetyStopAndReset(bool allowReset) {
    std::lock_guard controlLock(controlMutex_);
    const bool stopped = executeControl(stopCommand_, "stop");
    if (stopped) {
      motorRunning_.store(false);
      addEvent("motor_state", true, "stopped");
      return true;
    }
    if (allowReset && captureEverStarted_.load()) attemptResetAfterUnverifiedStop();
    return false;
  }

  void attemptResetAfterUnverifiedStop() {
    if (shouldResetAfterStopFailure(captureEverStarted_.load(), resetOnFailure_, resetAttempted_.load()) && !resetAttempted_.exchange(true)) {
      try {
        std::lock_guard lock(rspMutex_);
        (void)rsp_.monitor("reset");
        addEvent("reset", true, "single J-Link hardware reset command");
      } catch (const std::exception& error) {
        addEvent("reset", false, error.what());
      }
    }
  }

  void sampleLoop() noexcept {
    (void)SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    char* affinityValue = nullptr;
    size_t affinityLength = 0;
    if (_dupenv_s(&affinityValue, &affinityLength, "JLINK_CAPTURE_AFFINITY_MASK") == 0 && affinityValue != nullptr) {
      const std::unique_ptr<char, decltype(&std::free)> configuredAffinity(affinityValue, &std::free);
      char* end = nullptr;
      const unsigned long long mask = std::strtoull(configuredAffinity.get(), &end, 0);
      if (end != configuredAffinity.get() && *end == '\0' && mask != 0U) {
        if (SetThreadAffinityMask(GetCurrentThread(), static_cast<DWORD_PTR>(mask)) == 0) addEvent("affinity", false, "configured affinity could not be applied");
        else addEvent("affinity", true, configuredAffinity.get());
      } else {
        addEvent("affinity", false, "invalid JLINK_CAPTURE_AFFINITY_MASK");
      }
    }
    const int64_t period = frequency_ / rateHz_;
    int64_t deadline = captureStartQpc_;
    uint64_t frameIndex = 0;
    uint32_t consecutiveFailures = 0;
    bool durationStopSent = false;
    int64_t postStopDeadline = 0;
    try {
      while (!stopRequested_.load()) {
        deadline += period;
        while (qpcNow() < deadline) {
          const int64_t remaining = deadline - qpcNow();
          if (remaining > frequency_ / 500) std::this_thread::sleep_for(std::chrono::milliseconds(1));
          else YieldProcessor();
        }
        const int64_t now = qpcNow();
        const uint64_t skipped = missedPeriods(now, deadline, period);
        if (skipped > 0U) {
          missedDeadlines_.fetch_add(skipped);
          addEvent("missed_deadline", false, std::to_string(skipped));
          deadline += static_cast<int64_t>(skipped) * period;
          frameIndex += skipped;
        }

        BinaryFrame frame{};
        frame.index = frameIndex++;
        frame.scheduledQpc = deadline;
        try {
          {
            std::lock_guard lock(rspMutex_);
            readPlan(frame.rawValues, frame.readStartQpc, frame.readEndQpc);
          }
          frame.readMidpointQpc = frame.readStartQpc + (frame.readEndQpc - frame.readStartQpc) / 2;
          frame.readDurationQpc = frame.readEndQpc - frame.readStartQpc;
          frame.valid = 1;
          consecutiveFailures = 0;
        } catch (const std::exception& error) {
          ++consecutiveFailures;
          readFailures_.fetch_add(1);
          addEvent("read_failure", false, error.what());
          if (readFailureThreshold(consecutiveFailures)) {
            addEvent("read_failure_threshold", false, "three consecutive failures");
            (void)safetyStopAndReset(true);
            finalize(TerminalState::Failed, "three_consecutive_read_failures");
            return;
          }
          continue;
        }
        {
          std::lock_guard lock(bufferMutex_);
          BinaryFrame& stored = buffer_.addFrame();
          stored = frame;
        }

        const int64_t durationStart = durationStartQpc_.load();
        if (!durationStopSent && durationStart > 0 && qpcNow() >= durationStart + static_cast<int64_t>(durationSec_) * frequency_) {
          durationStopSent = true;
          if (!safetyStopAndReset(true)) {
            finalize(TerminalState::Failed, "duration_stop_unverified");
            return;
          }
          postStopDeadline = qpcNow() + static_cast<int64_t>(postStopMs_) * frequency_ / 1000;
        }
        if (durationStopSent && qpcNow() >= postStopDeadline) {
          finalize(TerminalState::Completed, "duration_completed");
          return;
        }
      }
    } catch (const std::exception& error) {
      addEvent("sampling_error", false, error.what());
      (void)safetyStopAndReset(true);
      finalize(TerminalState::Failed, "sampling_error");
    }
  }

  void finishFromCaller(TerminalState terminal, std::string reason, bool safetyFailure) {
    std::string current;
    {
      std::lock_guard lifecycle(lifecycleMutex_);
      if (state_ == "completed" || state_ == "stopped" || state_ == "failed" || state_ == "idle") return;
      current = state_;
      if (current == "preparing") {
        state_ = "failed";
        terminationReason_ = std::move(reason);
      }
    }
    if (current == "preparing") {
      rsp_.close();
      return;
    }
    stopRequested_.store(true);
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
    if (safetyFailure && captureEverStarted_.load()) (void)safetyStopAndReset(true);
    finalize(terminal, std::move(reason));
  }

  void finalize(TerminalState terminal, std::string reason) {
    {
      std::lock_guard lifecycle(lifecycleMutex_);
      if (state_ == "completed" || state_ == "stopped" || state_ == "failed") return;
      state_ = terminal == TerminalState::Completed ? "completed" : terminal == TerminalState::Stopped ? "stopped" : "failed";
      terminationReason_ = std::move(reason);
    }
    addEvent("termination", terminal != TerminalState::Failed, terminationReason_);
    persist(terminal);
    rsp_.close();
    notify_("capture_complete", status());
  }

  void persist(TerminalState terminal) {
    HANDLE file = CreateFileW(utf8Path(outputFile_).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Capture artifact already exists or cannot be created");
    try {
      std::lock_guard lock(bufferMutex_);
      BinaryHeader header;
      header.qpcFrequency = frequency_;
      header.symbolCount = static_cast<uint32_t>(symbols_.size());
      header.frameSize = sizeof(BinaryFrame);
      header.frameCount = buffer_.frameCount();
      header.eventCount = buffer_.eventCount();
      header.terminalState = static_cast<uint32_t>(terminal);
      writeAll(file, &header, sizeof(header));
      for (const Symbol& symbol : symbols_) {
        BinarySymbol record;
        copyText(record.name, symbol.name);
        copyText(record.alias, symbol.alias);
        copyText(record.unit, symbol.unit);
        record.address = symbol.address;
        record.size = symbol.size;
        record.type = static_cast<uint32_t>(symbol.type);
        writeAll(file, &record, sizeof(record));
      }
      writeAll(file, buffer_.frames(), buffer_.frameCount() * sizeof(BinaryFrame));
      writeAll(file, buffer_.events(), buffer_.eventCount() * sizeof(BinaryEvent));
      if (!FlushFileBuffers(file)) throw std::runtime_error("Capture artifact flush failed");
      CloseHandle(file);
    } catch (...) {
      CloseHandle(file);
      throw;
    }
    Json::Object sidecar = metadata_;
    sidecar["nativeVersion"] = Json(1.0);
    sidecar["state"] = Json(state_);
    sidecar["binaryFile"] = Json(outputFile_);
    sidecar["terminationReason"] = Json(terminationReason_);
    sidecar["capabilities"] = Json(capabilities_);
    sidecar["targetStatus"] = Json(lastTargetStatus_);
    sidecar["qpcFrequency"] = Json(static_cast<double>(frequency_));
    sidecar["frameCount"] = Json(static_cast<double>(buffer_.frameCount()));
    sidecar["eventCount"] = Json(static_cast<double>(buffer_.eventCount()));
    std::string sidecarPath = outputFile_;
    if (sidecarPath.ends_with(".jlcp")) sidecarPath.resize(sidecarPath.size() - 5U);
    sidecarPath += ".native.json";
    HANDLE metadataFile = CreateFileW(utf8Path(sidecarPath).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (metadataFile == INVALID_HANDLE_VALUE) throw std::runtime_error("Native metadata sidecar already exists or cannot be created");
    try {
      const std::string encoded = dumpJson(Json(std::move(sidecar)));
      writeAll(metadataFile, encoded.data(), encoded.size());
      if (!FlushFileBuffers(metadataFile)) throw std::runtime_error("Native metadata sidecar flush failed");
      CloseHandle(metadataFile);
    } catch (...) {
      CloseHandle(metadataFile);
      throw;
    }
  }
};



CaptureEngine::CaptureEngine(Notify notify, uint32_t calibrationSamples, double calibrationLimitUs)
    : impl_(std::make_unique<Impl>(std::move(notify), calibrationSamples, calibrationLimitUs)) {}
CaptureEngine::~CaptureEngine() = default;
Json CaptureEngine::prepare(const Json& payload) { return impl_->prepare(payload); }
Json CaptureEngine::start() { return impl_->start(); }
Json CaptureEngine::abortPreparation(std::string reason) { return impl_->abortPreparation(std::move(reason)); }
Json CaptureEngine::setMetadata(const Json& metadata) { return impl_->setMetadata(metadata); }
Json CaptureEngine::control(std::string_view command) { return impl_->control(command); }
Json CaptureEngine::stop() { return impl_->stop(); }
Json CaptureEngine::status() const { return impl_->status(); }
void CaptureEngine::parentLost() noexcept { impl_->parentLost(); }
void CaptureEngine::close() noexcept { impl_->close(); }

int runSelfTest() {
  const Json parsed = parseJson("{\"a\":[1,true,null,\"x\\n\"],\"b\":{\"c\":2}}");
  if (parsed.at("a").array().size() != 4U || parsed.at("b").at("c").number() != 2.0) return 1;
  bool rejected = false;
  try { (void)parseJson("{\"a\":1,\"a\":2}"); } catch (const std::exception&) { rejected = true; }
  if (!rejected) return 2;
  if (rspChecksum("qSupported") != 0x37U || rspPacket("qSupported") != "$qSupported#37") return 3;
  const std::string escaped = rspBinaryPacket(std::string("$#}*", 4));
  const std::array<unsigned char, 8> expectedEscaped = {'}', 0x04U, '}', 0x03U, '}', 0x5DU, '}', 0x0AU};
  if (escaped.size() < 9U || !std::equal(expectedEscaped.begin(), expectedEscaped.end(), escaped.begin() + 1)) return 27;
  const auto decoded = hexDecode("00017fff");
  if (decoded.size() != 4U || decoded[2] != 0x7FU || decoded[3] != 0xFFU) return 4;
  std::atomic<int> routed = 0;
  {
    ParentMonitor monitor(GetCurrentProcessId(), [&routed]() { ++routed; });
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  if (routed.load() != 0) return 5;
  if (percentile({1, 2, 3, 1000}, 0.999) != 1000 || missedPeriods(320, 100, 100) != 2U || missedPeriods(199, 100, 100) != 0U) return 6;
  if (readFailureThreshold(2) || !readFailureThreshold(3)) return 7;
  if (shouldResetAfterStopFailure(false, true, false) || shouldResetAfterStopFailure(true, false, false) || shouldResetAfterStopFailure(true, true, true) || !shouldResetAfterStopFailure(true, true, false)) return 20;
  if (!dhcsrConfirmsRunning(0x01010001U) || dhcsrConfirmsRunning(0x01030001U) || dhcsrConfirmsRunning(0x03010001U) || dhcsrConfirmsRunning(0xFFFFFFFFU)) return 24;
  ReadPlan passingPlan; passingPlan.p999Us = 99.0;
  ReadPlan failingPlan; failingPlan.p999Us = 101.0;
  if (!planPasses(passingPlan, 1000) || planPasses(failingPlan, 1000)) return 25;
  requireFlashMatch({1, 2, 3}, {1, 2, 3});
  bool staleElfRejected = false;
  try { requireFlashMatch({1, 2, 3}, {1, 2, 4}); } catch (const std::exception&) { staleElfRejected = true; }
  if (!staleElfRejected) return 23;
  const std::vector<Symbol> syntheticSymbols = {
    {"a", "", "", 0x20000000, 4, ScalarKind::Uint32},
    {"b", "", "", 0x20000004, 4, ScalarKind::Float32},
    {"c", "", "", 0x20000008, 2, ScalarKind::Uint16},
    {"d", "", "", 0x2000000A, 2, ScalarKind::Int16},
    {"e", "", "", 0x2000000C, 4, ScalarKind::Int32},
    {"f", "", "", 0x20000010, 1, ScalarKind::Uint8},
    {"g", "", "", 0x20000011, 1, ScalarKind::Int8},
  };
  const auto plans = buildReadPlans(syntheticSymbols, {{0x20000000, 0x20000100}});
  if (plans.empty() || plans.back().ranges.size() != 1U || plans.back().ranges[0].length != 18U) return 8;
  if (rawScalar(encodeScalar(ScalarKind::Int16, -123)) != 0xFF85U || decodeScalar(ScalarKind::Int16, 0xFF85U) != -123.0) return 21;
  const auto floatBytes = encodeScalar(ScalarKind::Float32, 1.5);
  if (decodeScalar(ScalarKind::Float32, rawScalar(floatBytes)) != 1.5) return 22;
  (void)SetProcessWorkingSetSize(GetCurrentProcess(), 32U * 1024U * 1024U, 48U * 1024U * 1024U);
  CaptureBuffer syntheticBuffer;
  syntheticBuffer.allocate(60'000, 32);
  for (uint64_t index = 0; index < 60'000; ++index) syntheticBuffer.addFrame().index = index;
  syntheticBuffer.addEvent(qpcNow(), "self_test", true, "seven variables at 1 kHz for 60 seconds");
  if (syntheticBuffer.frameCount() != 60'000U || syntheticBuffer.eventCount() != 1U) return 9;
  syntheticBuffer.release();

  wchar_t temporaryDirectory[MAX_PATH]{};
  wchar_t temporaryFile[MAX_PATH]{};
  if (GetTempPathW(MAX_PATH, temporaryDirectory) == 0 || GetTempFileNameW(temporaryDirectory, L"jlc", 0, temporaryFile) == 0) return 10;
  (void)DeleteFileW(temporaryFile);
  HANDLE artifact = CreateFileW(temporaryFile, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY, nullptr);
  if (artifact == INVALID_HANDLE_VALUE) return 11;
  BinaryHeader header;
  BinaryFrame frame;
  BinaryEvent event;
  header.qpcFrequency = qpcFrequency();
  header.symbolCount = 7;
  header.frameSize = sizeof(BinaryFrame);
  header.frameCount = 1;
  header.eventCount = 1;
  writeAll(artifact, &header, sizeof(header));
  writeAll(artifact, &frame, sizeof(frame));
  writeAll(artifact, &event, sizeof(event));
  CloseHandle(artifact);
  artifact = CreateFileW(temporaryFile, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY, nullptr);
  if (artifact != INVALID_HANDLE_VALUE) { CloseHandle(artifact); return 12; }
  artifact = CreateFileW(temporaryFile, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  BinaryHeader loaded;
  DWORD bytesRead = 0;
  const bool loadedOk = artifact != INVALID_HANDLE_VALUE && ReadFile(artifact, &loaded, sizeof(loaded), &bytesRead, nullptr) && bytesRead == sizeof(loaded);
  if (artifact != INVALID_HANDLE_VALUE) CloseHandle(artifact);
  (void)DeleteFileW(temporaryFile);
  if (!loadedOk || std::string_view(loaded.magic, 4) != "JLCP" || loaded.version != 1 || loaded.symbolCount != 7) return 13;

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  wchar_t childCommand[] = L"cmd.exe /c exit 0";
  if (!CreateProcessW(nullptr, childCommand, nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) return 14;
  std::atomic<int> childLost = 0;
  {
    ParentMonitor childMonitor(process.dwProcessId, [&childLost]() { ++childLost; });
    ResumeThread(process.hThread);
    for (int wait = 0; wait < 100 && childLost.load() == 0; ++wait) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  WaitForSingleObject(process.hProcess, 1000);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  if (childLost.load() != 1) return 15;
  WinsockSession winsock;
  auto engineScenario = [](int mode) {
    const bool failStop = mode == 1;
    FakeRspServer server(failStop);
    wchar_t directory[MAX_PATH]{};
    wchar_t fileName[MAX_PATH]{};
    if (GetTempPathW(MAX_PATH, directory) == 0 || GetTempFileNameW(directory, L"jle", 0, fileName) == 0) throw std::runtime_error("Engine self-test temp path failed");
    (void)DeleteFileW(fileName);
    const std::wstring sidecar = std::wstring(fileName) + L".native.json";
    (void)DeleteFileW(sidecar.c_str());
    const std::string outputFile = utf8Text(fileName);
    auto symbol = [](std::string name, double address) {
      return Json(object({
        {"name", Json(std::move(name))}, {"address", Json(address)}, {"size", Json(4.0)}, {"type", Json(std::string("uint32"))},
      }));
    };
    auto control = [&symbol](double value, double verifyValue) {
      return Json(object({
        {"target", symbol("command", 536870916.0)},
        {"value", Json(value)},
        {"timeoutMs", Json(100.0)},
        {"verify", Json(object({
          {"symbol", symbol("running", 536870920.0)}, {"operator", Json(std::string("eq"))}, {"value", Json(verifyValue)},
        }))},
      }));
    };
    Json payload(object({
      {"host", Json(std::string("127.0.0.1"))}, {"port", Json(static_cast<double>(server.port()))}, {"outputFile", Json(outputFile)},
      {"rateHz", Json(100.0)}, {"durationSec", Json(1.0)}, {"preStartMs", Json(0.0)}, {"postStopMs", Json(0.0)}, {"resetOnFailure", Json(true)},
      {"symbols", Json(Json::Array{symbol("sample", 536870912.0)})},
      {"ramRanges", Json(Json::Array{Json(object({{"start", Json(536870912.0)}, {"end", Json(536870976.0)}}))})},
      {"flashSections", Json(Json::Array{})},
      {"control", Json(object({{"start", control(1.0, 1.0)}, {"stop", control(0.0, 0.0)}}))},
    }));
    std::vector<std::string> notifications;
    CaptureEngine engine([&notifications](std::string type, Json) { notifications.push_back(std::move(type)); }, 5, 1'000'000.0);
    const int64_t calibrationStart = qpcNow();
    const Json prepared = engine.prepare(payload);
    if (prepared.at("state").string() != "armed") throw std::runtime_error("Engine self-test did not arm");
    if (!server.noAckEnabled()) throw std::runtime_error("Engine self-test did not enable RSP no-ack mode");
    if (qpcNow() - calibrationStart < qpcFrequency() * 3 / 100) throw std::runtime_error("Engine calibration was not rate paced");
    (void)engine.setMetadata(Json(object({
      {"version", Json(1.0)}, {"sessionId", Json(std::string("self-test"))}, {"elfSha256", Json(std::string(64U, '0'))},
    })));
    if (mode == 4) engine.parentLost();
    else {
      (void)engine.start();
      (void)engine.control("start");
      if (server.startWrites() != 1U) throw std::runtime_error("Engine self-test start was not written");
    }
    bool stopFailed = false;
    if (mode == 4) { /* armed parent loss must not touch control or reset */ }
    else if (mode == 2) engine.parentLost();
    else if (mode == 3) {
      for (int wait = 0; wait < 300 && engine.status().at("state").string() == "capturing"; ++wait) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    } else {
      try { (void)engine.control("stop"); } catch (const std::exception&) { stopFailed = true; }
    }
    const uint32_t expectedStops = mode == 4 ? 0U : 1U;
    if (stopFailed != failStop || server.stopWrites() != expectedStops || server.resets() != (failStop ? 1U : 0U)) throw std::runtime_error("Engine self-test safety routing mismatch");
    const Json status = engine.status();
    const std::string expectedState = mode == 0 ? "stopped" : mode == 3 ? "completed" : "failed";
    if (status.at("state").string() != expectedState) throw std::runtime_error("Engine self-test terminal state mismatch");
    HANDLE artifact = CreateFileW(fileName, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    BinaryHeader header;
    DWORD bytesRead = 0;
    const bool validArtifact = artifact != INVALID_HANDLE_VALUE && ReadFile(artifact, &header, sizeof(header), &bytesRead, nullptr) && bytesRead == sizeof(header) && std::string_view(header.magic, 4) == "JLCP";
    if (artifact != INVALID_HANDLE_VALUE) CloseHandle(artifact);
    (void)DeleteFileW(fileName);
    (void)DeleteFileW(sidecar.c_str());
    if (!validArtifact || notifications.empty() || notifications.back() != "capture_complete") throw std::runtime_error("Engine self-test persistence/event mismatch");
  };
  try {
    engineScenario(0);
    engineScenario(1);
    engineScenario(2);
    engineScenario(3);
    engineScenario(4);
  } catch (const std::exception& error) {
    std::cerr << "engine self-test failed: " << error.what() << '\n';
    return 26;
  }
  SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == INVALID_SOCKET) return 16;
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  if (bind(listener, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0 || listen(listener, 1) != 0) {
    closesocket(listener);
    return 17;
  }
  int addressLength = sizeof(address);
  if (getsockname(listener, reinterpret_cast<sockaddr*>(&address), &addressLength) != 0) {
    closesocket(listener);
    return 18;
  }
  std::jthread server([listener]() {
    SOCKET client = accept(listener, nullptr, nullptr);
    closesocket(listener);
    if (client == INVALID_SOCKET) return;
    char request[256]{};
    const int first = recv(client, request, sizeof(request), 0);
    if (first <= 0) { closesocket(client); return; }
    (void)send(client, "-", 1, 0);
    const int second = recv(client, request, sizeof(request), 0);
    if (second <= 0) { closesocket(client); return; }
    (void)send(client, "+", 1, 0);
    const std::string bad = "$PacketSize=4000#00";
    (void)send(client, bad.data(), static_cast<int>(bad.size()), 0);
    char nack = 0;
    (void)recv(client, &nack, 1, 0);
    const std::string good = rspPacket("PacketSize=4000");
    (void)send(client, good.data(), static_cast<int>(good.size()), 0);
    char ack = 0;
    (void)recv(client, &ack, 1, 0);
    closesocket(client);
  });
  RspClient client;
  client.connectTo("127.0.0.1", ntohs(address.sin_port), 1000);
  if (client.negotiate() != "PacketSize=4000") return 19;
  std::cout << "capture helper self-test: ok\n";
  return 0;
}



}  // namespace capture
