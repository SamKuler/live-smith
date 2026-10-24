import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";

export interface Vst3BrokerDescriptor {
  bridgeId: string;
  capability: string;
  port: number;
}

const installedData = path.join(os.homedir(), "Library", "Application Support", "Ableton",
  "Extensions Data", "sam-kuler.live-smith");
const privateDirectory = "vst3-view";
const descriptorName = "bridge.json";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Only the installed Extension may publish discovery. CLI data stays isolated. */
export function createVst3DiscoveryPublisher(
  storageDirectory: string | undefined,
  /** Test seam; production always uses the fixed installed Extension identity. */
  expectedDirectory = installedData,
) {
  if (!storageDirectory || path.resolve(storageDirectory) !== expectedDirectory) return undefined;
  return async (broker: Vst3BrokerDescriptor): Promise<{ clear(): Promise<void> }> => {
    if (!storageDirectory || path.resolve(storageDirectory) !== expectedDirectory ||
        await fs.realpath(storageDirectory) !== expectedDirectory ||
        !uuid.test(broker.bridgeId) || !/^[0-9a-f-]{72}$/iu.test(broker.capability) ||
        !Number.isInteger(broker.port) || broker.port < 1 || broker.port > 65535) {
      throw new Error("VST3 discovery is unavailable for this Extension storage.");
    }
    const directory = path.join(expectedDirectory, privateDirectory);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        directoryStat.uid !== process.getuid?.() || directoryStat.mode & 0o077) {
      throw new Error("VST3 discovery directory is not private.");
    }
    const destination = path.join(directory, descriptorName);
    try {
      const current = await fs.lstat(destination);
      if (!current.isFile() || current.isSymbolicLink() ||
          current.uid !== process.getuid?.() || current.mode & 0o077) {
        throw new Error("VST3 discovery descriptor is not private.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = path.join(directory, `.${descriptorName}.${broker.bridgeId}`);
    const content = JSON.stringify({ version: 1, ...broker });
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    try { await fs.rename(temporary, destination); }
    catch (error) { await fs.unlink(temporary); throw error; }
    return { clear: async () => {
      try {
        const current = await fs.readFile(destination, "utf8");
        if (JSON.parse(current).bridgeId === broker.bridgeId) await fs.unlink(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } };
  };
}
