#pragma once

#include "json.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>

namespace capture {

class CaptureEngine {
 public:
  using Notify = std::function<void(std::string, Json)>;

  explicit CaptureEngine(Notify notify, uint32_t calibrationSamples = 1000, double calibrationLimitUs = 100.0);
  ~CaptureEngine();
  CaptureEngine(const CaptureEngine&) = delete;
  CaptureEngine& operator=(const CaptureEngine&) = delete;

  [[nodiscard]] Json prepare(const Json& payload);
  [[nodiscard]] Json start();
  [[nodiscard]] Json abortPreparation(std::string reason);
  [[nodiscard]] Json setMetadata(const Json& metadata);
  [[nodiscard]] Json control(std::string_view command);
  [[nodiscard]] Json stop();
  [[nodiscard]] Json status() const;
  void parentLost() noexcept;
  void close() noexcept;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

[[nodiscard]] int runSelfTest();

}  // namespace capture
