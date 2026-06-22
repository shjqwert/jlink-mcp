static volatile int localScalar = 9;

int read_other_fixture(void) {
  return localScalar;
}
