import "reflect-metadata";

process.env.NODE_ENV ??= "test";
process.env.JWT_SECRET ??= "test-secret-do-not-use-in-production";
process.env.PORT ??= "2567";
