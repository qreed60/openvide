import assert from "node:assert/strict";
import { getProviderAdapter, listProviderRegistryEntries } from "./agentProviders.js";
import type { ProviderDetectionInfo } from "./agentProviders.js";

const installedTools: Record<string, ProviderDetectionInfo> = {
  codex: { available: true, command: "/usr/bin/codex" },
  opencode: { available: true, command: "/usr/bin/opencode" },
  openhands: { available: true, command: "/usr/bin/openhands" },
};

function provider(id: string) {
  const entry = listProviderRegistryEntries(installedTools).find((item) => item.id === id);
  assert.ok(entry, `Missing provider metadata for ${id}`);
  return entry;
}

const originalOpenCodeFlag = process.env.OPENVIDE_ENABLE_OPENCODE_PROVIDER;
const originalOpenHandsFlag = process.env.OPENVIDE_ENABLE_OPENHANDS_PROVIDER;

try {
  delete process.env.OPENVIDE_ENABLE_OPENCODE_PROVIDER;
  delete process.env.OPENVIDE_ENABLE_OPENHANDS_PROVIDER;
  const disabledOpenCode = provider("opencode");
  assert.equal(disabledOpenCode.available, true);
  assert.equal(disabledOpenCode.enabled, false);
  assert.equal(disabledOpenCode.executable, false);
  assert.equal(disabledOpenCode.status, "installed-but-disabled");
  assert.equal(getProviderAdapter("opencode"), undefined);

  process.env.OPENVIDE_ENABLE_OPENCODE_PROVIDER = "1";
  const enabledOpenCode = provider("opencode");
  assert.equal(enabledOpenCode.available, true);
  assert.equal(enabledOpenCode.enabled, true);
  assert.equal(enabledOpenCode.executable, true);
  assert.equal(enabledOpenCode.status, "enabled");
  assert.equal(getProviderAdapter("opencode")?.provider, "opencode");

  const openHands = provider("openhands");
  assert.equal(openHands.available, true);
  assert.equal(openHands.enabled, false);
  assert.equal(openHands.executable, false);
  assert.equal(openHands.status, "installed-but-disabled");
  assert.equal(getProviderAdapter("openhands"), undefined);

  process.env.OPENVIDE_ENABLE_OPENHANDS_PROVIDER = "1";
  const enabledOpenHands = provider("openhands");
  assert.equal(enabledOpenHands.available, true);
  assert.equal(enabledOpenHands.enabled, true);
  assert.equal(enabledOpenHands.executable, true);
  assert.equal(enabledOpenHands.status, "enabled");
  assert.equal(enabledOpenHands.modelOverride, false);
  assert.equal(getProviderAdapter("openhands")?.provider, "openhands");

  process.env.OPENVIDE_ENABLE_OPENCODE_PROVIDER = "1";
  const unavailableOpenCode = listProviderRegistryEntries({
    ...installedTools,
    opencode: { available: false },
  }).find((item) => item.id === "opencode");
  assert.ok(unavailableOpenCode);
  assert.equal(unavailableOpenCode.available, false);
  assert.equal(unavailableOpenCode.executable, false);
  assert.equal(unavailableOpenCode.status, "unavailable");

  const unavailableOpenHands = listProviderRegistryEntries({
    ...installedTools,
    openhands: { available: false },
  }).find((item) => item.id === "openhands");
  assert.ok(unavailableOpenHands);
  assert.equal(unavailableOpenHands.available, false);
  assert.equal(unavailableOpenHands.executable, false);
  assert.equal(unavailableOpenHands.status, "unavailable");
} finally {
  if (originalOpenCodeFlag === undefined) {
    delete process.env.OPENVIDE_ENABLE_OPENCODE_PROVIDER;
  } else {
    process.env.OPENVIDE_ENABLE_OPENCODE_PROVIDER = originalOpenCodeFlag;
  }
  if (originalOpenHandsFlag === undefined) {
    delete process.env.OPENVIDE_ENABLE_OPENHANDS_PROVIDER;
  } else {
    process.env.OPENVIDE_ENABLE_OPENHANDS_PROVIDER = originalOpenHandsFlag;
  }
}
