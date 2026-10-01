#include "sqlite3.h"
int sqlite3_vec_init(sqlite3 *db, char **pzErrMsg, const void *pApi);
int core_init(const char *unused) {
  return sqlite3_auto_extension((void (*)(void))sqlite3_vec_init);
}
