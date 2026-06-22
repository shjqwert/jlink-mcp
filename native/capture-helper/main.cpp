#include "capture-engine.h"
#include "json.h"
#include "parent-monitor.h"
#include "rsp.h"

#include <windows.h>

#include <atomic>
#include <charconv>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

using capture::CaptureEngine;
using capture::dumpJson;
using capture::Json;
using capture::object;
using capture::parseJson;
using capture::ParentMonitor;
using capture::runSelfTest;
using capture::WinsockSession;

constexpr int kIpcVersion = 1;

std::mutex outputMutex;

void sendMessage(const Json::Object& message) {
  std::lock_guard lock(outputMutex);
  std::cout << dumpJson(Json(message)) << '\n' << std::flush;
}

Json::Object response(std::string id, std::string type, Json payload) {
  return object({
    {"version", Json(static_cast<double>(kIpcVersion))},
    {"id", Json(std::move(id))},
    {"type", Json(std::move(type))},
    {"payload", std::move(payload)},
  });
}

void sendError(std::string id, std::string message) {
  sendMessage(response(std::move(id), "error", Json(object({{"message", Json(std::move(message))}}))));
}

DWORD parseParentPid(int argc, char** argv) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::string_view(argv[index]) == "--parent-pid") {
      unsigned long value = 0;
      const std::string_view text(argv[index + 1]);
      const auto result = std::from_chars(text.data(), text.data() + text.size(), value);
      if (result.ec != std::errc{} || result.ptr != text.data() + text.size() || value == 0 || value > MAXDWORD) throw std::runtime_error("Invalid --parent-pid");
      return static_cast<DWORD>(value);
    }
  }
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string_view(argv[1]) == "--self-test") return runSelfTest();

    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    WinsockSession winsock;
    std::atomic<bool> parentLost = false;
    CaptureEngine engine([](std::string type, Json payload) {
      sendMessage(response("event", std::move(type), std::move(payload)));
    });
    ParentMonitor monitor(parseParentPid(argc, argv), [&parentLost, &engine]() {
      parentLost.store(true);
      engine.parentLost();
      sendMessage(response("event", "parent_lost", Json(Json::Object{})));
      ExitProcess(3);
    });
    sendMessage(response("ready", "ready", Json(object({{"pid", Json(static_cast<double>(GetCurrentProcessId()))}}))));

    std::string line;
    while (!parentLost.load() && std::getline(std::cin, line)) {
      std::string id = "unknown";
      try {
        const Json message = parseJson(line);
        if (message.at("version").number() != static_cast<double>(kIpcVersion)) throw std::runtime_error("Unsupported IPC version");
        id = message.at("id").string();
        const std::string type = message.at("type").string();
        const Json& payload = message.at("payload");

        if (type == "hello") {
          sendMessage(response(id, "result", Json(object({{"helperVersion", Json(1.0)}}))));
        } else if (type == "prepare") {
          sendMessage(response(id, "result", engine.prepare(payload)));
        } else if (type == "start") {
          sendMessage(response(id, "result", engine.start()));
        } else if (type == "abort_prepare") {
          sendMessage(response(id, "result", engine.abortPreparation(payload.at("reason").string())));
        } else if (type == "metadata") {
          sendMessage(response(id, "result", engine.setMetadata(payload)));
        } else if (type == "status") {
          sendMessage(response(id, "result", engine.status()));
        } else if (type == "control") {
          sendMessage(response(id, "result", engine.control(payload.at("command").string())));
        } else if (type == "stop") {
          sendMessage(response(id, "result", engine.stop()));
        } else if (type == "shutdown") {
          engine.parentLost();
          sendMessage(response(id, "result", Json(object({{"stopped", Json(true)}}))));
          return 0;
        } else {
          throw std::runtime_error("Unknown IPC message type: " + type);
        }
      } catch (const std::exception& error) {
        sendError(id, error.what());
      }
    }

    if (!parentLost.load()) {
      engine.parentLost();
      sendMessage(response("event", "parent_lost", Json(Json::Object{})));
    }
    return parentLost.load() ? 3 : 0;
  } catch (const std::exception& error) {
    sendError("fatal", error.what());
    return 2;
  }
}
