#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>

#include "rsp.h"

#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace capture {

std::string hexEncode(std::string_view data) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(data.size() * 2U);
  for (const unsigned char ch : data) {
    result.push_back(digits[ch >> 4U]);
    result.push_back(digits[ch & 0x0FU]);
  }
  return result;
}

namespace {

uint8_t hexNibble(char ch) {
  if (ch >= '0' && ch <= '9') return static_cast<uint8_t>(ch - '0');
  if (ch >= 'a' && ch <= 'f') return static_cast<uint8_t>(ch - 'a' + 10);
  if (ch >= 'A' && ch <= 'F') return static_cast<uint8_t>(ch - 'A' + 10);
  throw std::runtime_error("Invalid hexadecimal data");
}

}  // namespace

std::vector<uint8_t> hexDecode(std::string_view data) {
  if ((data.size() % 2U) != 0U) throw std::runtime_error("Odd-length hexadecimal data");
  std::vector<uint8_t> result(data.size() / 2U);
  for (size_t index = 0; index < result.size(); ++index) {
    result[index] = static_cast<uint8_t>((hexNibble(data[index * 2U]) << 4U) | hexNibble(data[index * 2U + 1U]));
  }
  return result;
}

uint8_t rspChecksum(std::string_view payload) {
  uint8_t result = 0;
  for (const unsigned char ch : payload) result = static_cast<uint8_t>(result + ch);
  return result;
}

std::string rspPacket(std::string_view payload) {
  std::ostringstream out;
  out << '$' << payload << '#' << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(rspChecksum(payload));
  return out.str();
}

std::string rspBinaryPacket(std::string_view payload) {
  std::string encoded;
  encoded.reserve(payload.size());
  for (const unsigned char ch : payload) {
    if (ch == '#' || ch == '$' || ch == '}' || ch == '*') {
      encoded.push_back('}');
      encoded.push_back(static_cast<char>(ch ^ 0x20U));
    } else {
      encoded.push_back(static_cast<char>(ch));
    }
  }
  return rspPacket(encoded);
}

WinsockSession::WinsockSession() {
  WSADATA data{};
  if (WSAStartup(MAKEWORD(2, 2), &data) != 0) throw std::runtime_error("WSAStartup failed");
}

WinsockSession::~WinsockSession() {
  WSACleanup();
}

class RspClient::Impl {
 public:
  ~Impl() { close(); }

  void connectTo(std::string_view host, uint16_t port, int timeoutMs) {
    close();
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo* addresses = nullptr;
    const std::string portText = std::to_string(port);
    if (getaddrinfo(std::string(host).c_str(), portText.c_str(), &hints, &addresses) != 0) throw std::runtime_error("RSP host resolution failed");
    for (const addrinfo* current = addresses; current != nullptr; current = current->ai_next) {
      socket_ = socket(current->ai_family, current->ai_socktype, current->ai_protocol);
      if (socket_ == INVALID_SOCKET) continue;
      const DWORD timeout = static_cast<DWORD>(timeoutMs);
      setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
      setsockopt(socket_, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));
      if (::connect(socket_, current->ai_addr, static_cast<int>(current->ai_addrlen)) == 0) break;
      closesocket(socket_);
      socket_ = INVALID_SOCKET;
    }
    freeaddrinfo(addresses);
    if (socket_ == INVALID_SOCKET) throw std::runtime_error("RSP connection failed or timed out");
    const BOOL noDelay = TRUE;
    if (setsockopt(socket_, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&noDelay), sizeof(noDelay)) != 0) {
      close();
      throw std::runtime_error("Failed to enable TCP_NODELAY for RSP");
    }
  }

  void close() noexcept {
    if (socket_ != INVALID_SOCKET) {
      shutdown(socket_, SD_BOTH);
      closesocket(socket_);
      socket_ = INVALID_SOCKET;
    }
    noAckMode_ = false;
    binaryMemoryRead_ = false;
  }

  void setIoTimeout(int timeoutMs) {
    if (socket_ == INVALID_SOCKET || timeoutMs < 1) throw std::runtime_error("Invalid RSP I/O timeout");
    const DWORD timeout = static_cast<DWORD>(timeoutMs);
    if (setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) != 0
        || setsockopt(socket_, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout)) != 0) {
      throw std::runtime_error("Failed to configure RSP I/O timeout");
    }
  }

  [[nodiscard]] std::string request(std::string_view payload) {
    if (socket_ == INVALID_SOCKET) throw std::runtime_error("RSP is not connected");
    const std::string packet = rspPacket(payload);
    if (noAckMode_) {
      sendAll(packet);
      return receivePacket();
    }
    for (int attempt = 0; attempt < 3; ++attempt) {
      sendAll(packet);
      const char acknowledgement = receiveByte();
      if (acknowledgement == '+') return receivePacket();
      if (acknowledgement != '-') throw std::runtime_error("RSP acknowledgement missing");
    }
    throw std::runtime_error("RSP packet rejected after three attempts");
  }

  [[nodiscard]] std::string negotiate() {
    const std::string capabilities = request("qSupported:multiprocess+;swbreak-;hwbreak-");
    if (capabilities.empty() || capabilities[0] == 'E') throw std::runtime_error("RSP capability negotiation failed: " + capabilities);
    if (capabilities.find("QStartNoAckMode+") != std::string::npos) {
      if (request("QStartNoAckMode") != "OK") throw std::runtime_error("RSP no-ack negotiation failed");
      noAckMode_ = true;
    }
    binaryMemoryRead_ = capabilities.find("binary-upload+") != std::string::npos;
    return capabilities;
  }

  [[nodiscard]] std::vector<uint8_t> readMemory(uint64_t address, size_t length) {
    std::ostringstream command;
    command << (binaryMemoryRead_ ? 'x' : 'm') << std::hex << address << ',' << length;
    const std::string response = request(command.str());
    if (response.empty() || response[0] == 'E') throw std::runtime_error("RSP memory read failed: " + response);
    std::vector<uint8_t> bytes;
    if (binaryMemoryRead_) {
      const size_t offset = response.size() == length + 1U && response[0] == 'b' ? 1U : 0U;
      if (response.size() - offset != length) throw std::runtime_error("RSP binary memory read returned an unexpected length");
      bytes.assign(response.begin() + static_cast<std::ptrdiff_t>(offset), response.end());
    } else {
      bytes = hexDecode(response);
    }
    if (bytes.size() != length) throw std::runtime_error("RSP memory read returned an unexpected length");
    return bytes;
  }

  void writeMemory(uint64_t address, const std::vector<uint8_t>& bytes) {
    std::ostringstream command;
    command << 'M' << std::hex << address << ',' << bytes.size() << ':';
    const std::string data(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    command << hexEncode(data);
    const std::string response = request(command.str());
    if (response != "OK") throw std::runtime_error("RSP memory write failed: " + response);
  }

  [[nodiscard]] std::string monitor(std::string_view command) {
    if (socket_ == INVALID_SOCKET) throw std::runtime_error("RSP is not connected");
    sendAll(rspPacket("qRcmd," + hexEncode(command)));
    if (!noAckMode_ && receiveByte() != '+') throw std::runtime_error("RSP monitor acknowledgement missing");
    std::string output;
    for (int packets = 0; packets < 128; ++packets) {
      const std::string response = receivePacket();
      if (response == "OK") return output;
      if (!response.empty() && response[0] == 'E') throw std::runtime_error("RSP monitor command failed: " + response);
      if (!response.empty() && response[0] == 'O') {
        const auto bytes = hexDecode(std::string_view(response).substr(1));
        output.append(reinterpret_cast<const char*>(bytes.data()), bytes.size());
      } else {
        output += response;
      }
    }
    throw std::runtime_error("RSP monitor response exceeded packet limit");
  }

 private:
  SOCKET socket_ = INVALID_SOCKET;
  bool noAckMode_ = false;
  bool binaryMemoryRead_ = false;

  void sendAll(std::string_view data) {
    size_t sent = 0;
    while (sent < data.size()) {
      const int count = send(socket_, data.data() + sent, static_cast<int>(data.size() - sent), 0);
      if (count <= 0) throw std::runtime_error("RSP send failed or timed out");
      sent += static_cast<size_t>(count);
    }
  }

  [[nodiscard]] char receiveByte() {
    char ch = 0;
    const int count = recv(socket_, &ch, 1, 0);
    if (count != 1) throw std::runtime_error("RSP receive failed or timed out");
    return ch;
  }

  [[nodiscard]] std::string receivePacket() {
    for (;;) {
      char ch = receiveByte();
      if (ch != '$') continue;
      std::string encoded;
      while ((ch = receiveByte()) != '#') encoded.push_back(ch);
      const char checksumText[2] = { receiveByte(), receiveByte() };
      const uint8_t expected = static_cast<uint8_t>((hexNibble(checksumText[0]) << 4U) | hexNibble(checksumText[1]));
      if (expected != rspChecksum(encoded)) {
        if (noAckMode_) throw std::runtime_error("RSP response checksum mismatch in no-ack mode");
        sendAll("-");
        continue;
      }
      if (!noAckMode_) sendAll("+");
      std::string payload;
      payload.reserve(encoded.size());
      for (size_t index = 0; index < encoded.size(); ++index) {
        if (encoded[index] != '}') payload.push_back(encoded[index]);
        else {
          if (++index >= encoded.size()) throw std::runtime_error("RSP response ended with an escape byte");
          payload.push_back(static_cast<char>(static_cast<unsigned char>(encoded[index]) ^ 0x20U));
        }
      }
      return payload;
    }
  }
};

RspClient::RspClient() : impl_(std::make_unique<Impl>()) {}
RspClient::~RspClient() = default;
void RspClient::connectTo(std::string_view host, uint16_t port, int timeoutMs) { impl_->connectTo(host, port, timeoutMs); }
void RspClient::close() noexcept { impl_->close(); }
void RspClient::setIoTimeout(int timeoutMs) { impl_->setIoTimeout(timeoutMs); }
std::string RspClient::request(std::string_view payload) { return impl_->request(payload); }
std::string RspClient::negotiate() { return impl_->negotiate(); }
std::vector<uint8_t> RspClient::readMemory(uint64_t address, size_t length) { return impl_->readMemory(address, length); }
void RspClient::writeMemory(uint64_t address, const std::vector<uint8_t>& bytes) { impl_->writeMemory(address, bytes); }
std::string RspClient::monitor(std::string_view command) { return impl_->monitor(command); }

}  // namespace capture
