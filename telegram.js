try {
  require("./dist/index.js");
} catch (error) {
  if (error && error.code === "MODULE_NOT_FOUND") {
    console.error("Build the connector first with `npm run build`, then run `npm start`.");
    process.exit(1);
  }
  throw error;
}
