#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace capture {

[[nodiscard]] std::string hexEncode(std::string_view data);
[[nodiscard]] std::vector<uint8_t> hexDecode(std::string_view data);
[[nodiscard]] uint8_t rspChecksum(std::string_view payload);
[[nodiscard]] std::string rspPacket(std::string_view payload);
[[nodiscard]] std::string rspBinaryPacket(std::string_view payload);

class WinsockSession {
 public:
  WinsockSession();
  ~WinsockSession();
  WinsockSession(const WinsockSession&) = delete;
  WinsockSession& operator=(const WinsockSession&) = delete;
};

class RspClient {
 public:
  RspClient();
  ~RspClient();
  RspClient(const RspClient&) = delete;
  RspClient& operator=(const RspClient&) = delete;

  void connectTo(std::string_view host, uint16_t port, int timeoutMs);
  void close() noexcept;
  void setIoTimeout(int timeoutMs);
  [[nodiscard]] std::string request(std::string_view payload);
  [[nodiscard]] std::string negotiate();
  [[nodiscard]] std::vector<uint8_t> readMemory(uint64_t address, size_t length);
  void writeMemory(uint64_t address, const std::vector<uint8_t>& bytes);
  [[nodiscard]] std::string monitor(std::string_view command);

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace capture
