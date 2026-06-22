#include "json.h"

#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace capture {

Json::Json(bool value) : value(value) {}
Json::Json(double value) : value(value) {}
Json::Json(std::string value) : value(std::move(value)) {}
Json::Json(Object value) : value(std::move(value)) {}
Json::Json(Array value) : value(std::move(value)) {}

const Json::Object& Json::object() const {
  if (!std::holds_alternative<Object>(value)) throw std::runtime_error("JSON value is not an object");
  return std::get<Object>(value);
}

const Json::Array& Json::array() const {
  if (!std::holds_alternative<Array>(value)) throw std::runtime_error("JSON value is not an array");
  return std::get<Array>(value);
}

const std::string& Json::string() const {
  if (!std::holds_alternative<std::string>(value)) throw std::runtime_error("JSON value is not a string");
  return std::get<std::string>(value);
}

double Json::number() const {
  if (!std::holds_alternative<double>(value)) throw std::runtime_error("JSON value is not a number");
  return std::get<double>(value);
}

bool Json::boolean() const {
  if (!std::holds_alternative<bool>(value)) throw std::runtime_error("JSON value is not a boolean");
  return std::get<bool>(value);
}

const Json& Json::at(std::string_view key) const {
  const auto& values = object();
  const auto found = values.find(std::string(key));
  if (found == values.end()) throw std::runtime_error("Missing JSON field: " + std::string(key));
  return found->second;
}

const Json* Json::find(std::string_view key) const {
  const auto& values = object();
  const auto found = values.find(std::string(key));
  return found == values.end() ? nullptr : &found->second;
}

namespace {

class Parser {
 public:
  explicit Parser(std::string_view input) : input_(input) {}

  [[nodiscard]] Json parse() {
    Json result = parseValue();
    whitespace();
    if (position_ != input_.size()) fail("trailing data");
    return result;
  }

 private:
  std::string_view input_;
  size_t position_ = 0;

  [[noreturn]] void fail(std::string_view message) const {
    throw std::runtime_error("Invalid JSON at byte " + std::to_string(position_) + ": " + std::string(message));
  }

  void whitespace() {
    while (position_ < input_.size() && (input_[position_] == ' ' || input_[position_] == '\t' || input_[position_] == '\r' || input_[position_] == '\n')) ++position_;
  }

  [[nodiscard]] bool consume(char ch) {
    whitespace();
    if (position_ >= input_.size() || input_[position_] != ch) return false;
    ++position_;
    return true;
  }

  [[nodiscard]] Json parseValue() {
    whitespace();
    if (position_ >= input_.size()) fail("expected value");
    const char ch = input_[position_];
    if (ch == '{') return parseObject();
    if (ch == '[') return parseArray();
    if (ch == '"') return Json(parseString());
    if (ch == 't') return literal("true", Json(true));
    if (ch == 'f') return literal("false", Json(false));
    if (ch == 'n') return literal("null", Json());
    if (ch == '-' || (ch >= '0' && ch <= '9')) return Json(parseNumber());
    fail("unexpected character");
  }

  [[nodiscard]] Json literal(std::string_view text, Json value) {
    if (input_.substr(position_, text.size()) != text) fail("invalid literal");
    position_ += text.size();
    return value;
  }

  [[nodiscard]] Json parseObject() {
    if (!consume('{')) fail("expected object");
    Json::Object result;
    if (consume('}')) return Json(std::move(result));
    for (;;) {
      whitespace();
      if (position_ >= input_.size() || input_[position_] != '"') fail("expected object key");
      std::string key = parseString();
      if (!consume(':')) fail("expected ':'");
      if (!result.emplace(std::move(key), parseValue()).second) fail("duplicate object key");
      if (consume('}')) return Json(std::move(result));
      if (!consume(',')) fail("expected ','");
    }
  }

  [[nodiscard]] Json parseArray() {
    if (!consume('[')) fail("expected array");
    Json::Array result;
    if (consume(']')) return Json(std::move(result));
    for (;;) {
      result.push_back(parseValue());
      if (consume(']')) return Json(std::move(result));
      if (!consume(',')) fail("expected ','");
    }
  }

  [[nodiscard]] std::string parseString() {
    if (!consume('"')) fail("expected string");
    std::string result;
    while (position_ < input_.size()) {
      const unsigned char ch = static_cast<unsigned char>(input_[position_++]);
      if (ch == '"') return result;
      if (ch < 0x20U) fail("control character in string");
      if (ch != '\\') {
        result.push_back(static_cast<char>(ch));
        continue;
      }
      if (position_ >= input_.size()) fail("truncated escape");
      switch (input_[position_++]) {
        case '"': result.push_back('"'); break;
        case '\\': result.push_back('\\'); break;
        case '/': result.push_back('/'); break;
        case 'b': result.push_back('\b'); break;
        case 'f': result.push_back('\f'); break;
        case 'n': result.push_back('\n'); break;
        case 'r': result.push_back('\r'); break;
        case 't': result.push_back('\t'); break;
        case 'u': appendUnicode(result); break;
        default: fail("invalid escape");
      }
    }
    fail("unterminated string");
  }

  void appendUnicode(std::string& result) {
    if (position_ + 4U > input_.size()) fail("truncated unicode escape");
    uint32_t codepoint = 0;
    for (int index = 0; index < 4; ++index) {
      const char ch = input_[position_++];
      codepoint <<= 4U;
      if (ch >= '0' && ch <= '9') codepoint |= static_cast<uint32_t>(ch - '0');
      else if (ch >= 'a' && ch <= 'f') codepoint |= static_cast<uint32_t>(ch - 'a' + 10);
      else if (ch >= 'A' && ch <= 'F') codepoint |= static_cast<uint32_t>(ch - 'A' + 10);
      else fail("invalid unicode escape");
    }
    if (codepoint <= 0x7FU) result.push_back(static_cast<char>(codepoint));
    else if (codepoint <= 0x7FFU) {
      result.push_back(static_cast<char>(0xC0U | (codepoint >> 6U)));
      result.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    } else {
      result.push_back(static_cast<char>(0xE0U | (codepoint >> 12U)));
      result.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3FU)));
      result.push_back(static_cast<char>(0x80U | (codepoint & 0x3FU)));
    }
  }

  [[nodiscard]] double parseNumber() {
    const size_t start = position_;
    if (input_[position_] == '-') ++position_;
    if (position_ >= input_.size()) fail("truncated number");
    if (input_[position_] == '0') ++position_;
    else {
      if (input_[position_] < '1' || input_[position_] > '9') fail("invalid number");
      while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') ++position_;
    }
    if (position_ < input_.size() && input_[position_] == '.') {
      ++position_;
      const size_t fraction = position_;
      while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') ++position_;
      if (fraction == position_) fail("invalid fraction");
    }
    if (position_ < input_.size() && (input_[position_] == 'e' || input_[position_] == 'E')) {
      ++position_;
      if (position_ < input_.size() && (input_[position_] == '+' || input_[position_] == '-')) ++position_;
      const size_t exponent = position_;
      while (position_ < input_.size() && input_[position_] >= '0' && input_[position_] <= '9') ++position_;
      if (exponent == position_) fail("invalid exponent");
    }
    const std::string text(input_.substr(start, position_ - start));
    char* end = nullptr;
    const double value = std::strtod(text.c_str(), &end);
    if (end == text.c_str() || !std::isfinite(value)) fail("invalid finite number");
    return value;
  }
};

std::string jsonEscape(std::string_view value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20U) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<unsigned>(ch);
        else out << static_cast<char>(ch);
    }
  }
  return out.str();
}

}  // namespace

Json parseJson(std::string_view input) {
  return Parser(input).parse();
}

std::string dumpJson(const Json& json) {
  if (std::holds_alternative<std::nullptr_t>(json.value)) return "null";
  if (std::holds_alternative<bool>(json.value)) return std::get<bool>(json.value) ? "true" : "false";
  if (std::holds_alternative<double>(json.value)) {
    std::ostringstream out;
    out << std::setprecision(17) << std::get<double>(json.value);
    return out.str();
  }
  if (std::holds_alternative<std::string>(json.value)) return "\"" + jsonEscape(std::get<std::string>(json.value)) + "\"";
  if (std::holds_alternative<Json::Array>(json.value)) {
    std::string result = "[";
    for (const auto& item : std::get<Json::Array>(json.value)) {
      if (result.size() > 1U) result += ',';
      result += dumpJson(item);
    }
    return result + ']';
  }
  std::string result = "{";
  for (const auto& [key, value] : std::get<Json::Object>(json.value)) {
    if (result.size() > 1U) result += ',';
    result += "\"" + jsonEscape(key) + "\":" + dumpJson(value);
  }
  return result + '}';
}

Json::Object object(std::initializer_list<std::pair<const std::string, Json>> values) {
  return Json::Object(values);
}

}  // namespace capture
