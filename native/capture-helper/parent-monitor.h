#pragma once

#include <cstdint>
#include <functional>
#include <memory>

namespace capture {

class ParentMonitor {
 public:
  ParentMonitor(uint32_t parentPid, std::function<void()> onParentLost);
  ~ParentMonitor();
  ParentMonitor(const ParentMonitor&) = delete;
  ParentMonitor& operator=(const ParentMonitor&) = delete;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace capture
