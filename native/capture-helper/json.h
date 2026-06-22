#pragma once

#include <initializer_list>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace capture {

struct Json {
  using Object = std::map<std::string, Json>;
  using Array = std::vector<Json>;
  using Value = std::variant<std::nullptr_t, bool, double, std::string, Object, Array>;

  Value value = nullptr;

  Json() = default;
  explicit Json(bool value);
  explicit Json(double value);
  explicit Json(std::string value);
  explicit Json(Object value);
  explicit Json(Array value);

  [[nodiscard]] const Object& object() const;
  [[nodiscard]] const Array& array() const;
  [[nodiscard]] const std::string& string() const;
  [[nodiscard]] double number() const;
  [[nodiscard]] bool boolean() const;
  [[nodiscard]] const Json& at(std::string_view key) const;
  [[nodiscard]] const Json* find(std::string_view key) const;
};

[[nodiscard]] Json parseJson(std::string_view input);
[[nodiscard]] std::string dumpJson(const Json& json);
[[nodiscard]] Json::Object object(std::initializer_list<std::pair<const std::string, Json>> values);

}  // namespace capture
