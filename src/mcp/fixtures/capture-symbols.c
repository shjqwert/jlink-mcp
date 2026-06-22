typedef unsigned char uint8_t;
typedef unsigned int uint32_t;
typedef signed short int16_t;
typedef signed char BOOL;
typedef float float32;

typedef struct {
  float32 fThetaRad;
  uint32_t running;
} MotorDebug;

volatile MotorDebug gstMotorDbg = { 1.25f, 0u };
volatile uint32_t gCommand = 0u;
volatile BOOL gRunEnable = 0;
volatile uint8_t gArray[2] = { 1u, 2u };
volatile uint32_t* gPointer = &gCommand;
struct { unsigned enabled : 1; } gBits = { 0u };
struct __attribute__((packed)) { uint8_t pad; uint32_t value; } gPacked = { 0u, 3u };
const uint32_t gReadOnly = 42u;
static volatile int16_t localScalar = -7;

int read_fixture(void) {
  return (int)gstMotorDbg.running + localScalar;
}
