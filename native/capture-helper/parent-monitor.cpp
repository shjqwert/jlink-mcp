#include <windows.h>

#include "parent-monitor.h"

#include <stdexcept>
#include <thread>
#include <utility>

namespace capture {

class ParentMonitor::Impl {
 public:
  Impl(uint32_t parentPid, std::function<void()> onParentLost) {
    if (parentPid == 0) return;
    HANDLE process = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (process == nullptr) throw std::runtime_error("Cannot open parent process handle");
    thread_ = std::jthread([process, onParentLost = std::move(onParentLost)](std::stop_token stop) {
      while (!stop.stop_requested()) {
        const DWORD result = WaitForSingleObject(process, 100);
        if (result == WAIT_OBJECT_0) {
          onParentLost();
          break;
        }
        if (result == WAIT_FAILED) break;
      }
      CloseHandle(process);
    });
  }

 private:
  std::jthread thread_;
};

ParentMonitor::ParentMonitor(uint32_t parentPid, std::function<void()> onParentLost)
    : impl_(std::make_unique<Impl>(parentPid, std::move(onParentLost))) {}
ParentMonitor::~ParentMonitor() = default;

}  // namespace capture
