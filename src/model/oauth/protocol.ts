import type { OAuthCredential } from "../../storage/oauth-credentials.js";
import type { DraftProfile } from "../profile.js";
import type {
  DiscoveredModelInfo,
  TransportRequest,
} from "../provider.js";
import type { ModelTurn } from "../contracts.js";

export interface OAuthModelProtocol {
  listModels(
    profile: DraftProfile,
    credential: OAuthCredential,
    signal?: AbortSignal,
  ): Promise<DiscoveredModelInfo[]>;
  createToolTurn(
    request: TransportRequest,
    credential: OAuthCredential,
  ): Promise<ModelTurn>;
}
