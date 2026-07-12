import assert from "node:assert/strict";
import test from "node:test";
import sqlite3 from "sqlite3";

test("sqlite3 loads its native binding and passes integrity_check", (_, done) => {
  const database = new sqlite3.Database(":memory:", (openError) => {
    if (openError) {
      done(openError);
      return;
    }
    database.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)", (createError) => {
      if (createError) {
        database.close(() => done(createError));
        return;
      }
      database.get<{ integrity_check: string }>("PRAGMA integrity_check", (checkError, row) => {
        database.close((closeError) => {
          try {
            assert.ifError(checkError);
            assert.deepEqual(row, { integrity_check: "ok" });
            assert.ifError(closeError);
            done();
          } catch (error) {
            done(error);
          }
        });
      });
    });
  });
});
