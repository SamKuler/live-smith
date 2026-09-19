import { isDeepStrictEqual } from "node:util";
import { AudioSubmissionNotStartedError, type AudioGenerationAdapter } from "../audio-services/contracts.js";
import { createSunoAudioAdapter } from "../audio-services/suno.js";
import { assertSunoVerificationFresh, SunoVerificationError, type SunoVerificationProof } from "../audio-services/suno-verification.js";
import { loadAgentSettings } from "../storage/settings.js";
import { createProxyAwareFetch } from "../runtime/proxy-fetch.js";
import { readSystemProxyConfiguration } from "../runtime/system-proxy.js";
import { runSunoHumanVerification } from "../runtime/suno-human-verification.js";
import type { AudioProcessingContext } from "./audio-processing.js";
import { resolveIntegrationConnection, type RuntimeIntegrationConnection } from "./integration-connections.js";
import { providerFetchForStorage } from "./provider-fetch.js";
import { persistRotatedSunoSession } from "./suno-session-manager.js";
import { audioMessage as m } from "./audio-messages.js";

interface Dependencies {
  verify?: typeof runSunoHumanVerification;
  fetchImpl?: typeof fetch;
  readSystemProxy?: typeof readSystemProxyConfiguration;
}

/** This factory keeps native proof, account admission and network routing private. */
export function createAppSunoGenerationAdapter(
  context: AudioProcessingContext, settings: RuntimeIntegrationConnection,
  authorizeDownloads = false, dependencies: Dependencies = {},
): AudioGenerationAdapter {
  if (settings.provider !== "suno" || !settings.sunoSession) throw new Error("A saved Suno session is required.");
  const verify = dependencies.verify ?? runSunoHumanVerification;
  const readSystemProxy = dependencies.readSystemProxy ?? readSystemProxyConfiguration;
  const ordinaryFetch = dependencies.fetchImpl ?? providerFetchForStorage(context.storageDirectory);
  let lease: { revision: string; selection: Awaited<ReturnType<typeof loadAgentSettings>>["networkProxy"];
    system?: Awaited<ReturnType<typeof readSystemProxy>> } | undefined;
  let proof: SunoVerificationProof | undefined;
  let submissionFetch: typeof fetch | undefined;
  const active = (signal: AbortSignal) => { if (signal.aborted) throw new SunoVerificationError("cancelled"); };
  const validateLease = async (signal: AbortSignal) => {
    active(signal);
    const saved = await loadAgentSettings(context.storageDirectory);
    if (!lease || saved.networkProxyRevision !== lease.revision || !isDeepStrictEqual(saved.networkProxy, lease.selection) ||
        lease.system && !isDeepStrictEqual(await readSystemProxy(), lease.system)) {
      throw new AudioSubmissionNotStartedError("Suno.com audio service: the network route changed during verification. No generation was submitted.");
    }
    await resolveIntegrationConnection(context.storageDirectory, settings.id, "generate_music", [settings]);
    active(signal);
  };
  const fetchImpl = ((input, init) => (submissionFetch ?? ordinaryFetch)(input, init)) as typeof fetch;
  return createSunoAudioAdapter(settings.sunoSession, {
    fetchImpl, authorizeDownloads,
    onSessionRefresh: (previous, next, signal) => persistRotatedSunoSession(
      context.storageDirectory, settings.id, settings.sunoSession!.accountId, previous, next, signal,
    ),
    ...(settings.modelId ? { modelId: settings.modelId } : {}),
    authorizeSubmission: async (signal, dispatch) => {
      let dispatchEntered = false;
      try {
        if (!context.withGenerationAuthorization) throw new Error();
        return await context.withGenerationAuthorization(signal, async () => {
          if (proof) {
            await validateLease(signal);
            assertSunoVerificationFresh(proof);
            const route = lease!;
            submissionFetch = dependencies.fetchImpl ?? createProxyAwareFetch(async () => route.selection, {
              readSystemProxy: async () => route.system ?? await readSystemProxy(),
            });
          } else await resolveIntegrationConnection(context.storageDirectory, settings.id, "generate_music", [settings]);
          active(signal);
          dispatchEntered = true;
          // The adapter now authenticates and rechecks the *complete* original
          // request/proof under the same lease, then retains its bounded receipt.
          return dispatch();
        });
      } catch (error) {
        if (dispatchEntered) throw error;
        const notStarted = new AudioSubmissionNotStartedError("Suno.com audio service: generation authorization or verification is no longer valid. No generation was submitted.");
        if (signal.aborted) notStarted.name = "AbortError";
        throw notStarted;
      } finally { submissionFetch = undefined; proof = undefined; lease = undefined; }
    },
    verifyHuman: async (captchaVersion, signal) => {
      active(signal);
      proof = undefined;
      await resolveIntegrationConnection(context.storageDirectory, settings.id, "generate_music", [settings]);
      const saved = await loadAgentSettings(context.storageDirectory);
      lease = { revision: saved.networkProxyRevision, selection: { ...saved.networkProxy },
        ...(saved.networkProxy.mode === "system" ? { system: await readSystemProxy() } : {}),
      };
      await context.onProgress?.(m("Complete Suno verification in the Live Smith window"));
      const result = await verify({ captchaVersion, signal, networkProxy: lease.selection,
        interfaceLanguage: saved.uiLanguage, connectionName: settings.name });
      await validateLease(signal);
      proof = result;
      return result;
    },
  });
}
