// CI supplies matching native and release-manifest identities. Local builds keep app.json defaults.
module.exports = ({ config }) => {
  const version = process.env.MOOSE_VERSION ?? config.version;
  const versionCode = Number(
    process.env.MOOSE_BUILD_NUMBER ?? config.android?.versionCode ?? 1,
  );
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid MOOSE_VERSION");
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode < 1 ||
    versionCode > 2100000000
  )
    throw new Error("Invalid MOOSE_BUILD_NUMBER");
  return { ...config, version, android: { ...config.android, versionCode } };
};
