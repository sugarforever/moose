const fs = require("node:fs");
const path = require("node:path");
const prepared = fs.existsSync(
  path.join(__dirname, "vendor/MooseISHCore.xcframework"),
);
module.exports = {
  dependency: {
    platforms: {
      ios:
        prepared || process.env.MOOSE_ISH_NATIVE === "1"
          ? { podspecPath: path.join(__dirname, "MooseISH.podspec") }
          : null,
      android: null,
    },
  },
};
