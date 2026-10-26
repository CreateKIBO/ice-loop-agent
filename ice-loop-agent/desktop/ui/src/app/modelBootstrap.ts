// Read-only bootstrap contracts and hooks shared by first-screen consumers.
import { useAccountQuery } from "../data/client";
import { writingReadiness, type ModelRoute } from "./modelRoutes";

export type ModelProfile = {
  provider: string; profile_id: string; model_id: string; base_url: string;
  status: string; has_key: boolean;
  limits_hash?:string; token_count_supported?:boolean;
  extra?:{max_output_tokens?:number|null;token_check?:'auto'|'required'|'off';context_window_override?:{base_url:string;model_id:string;context_window:number;source?:string};model_window?:{model_id:string;base_url:string;context_window?:number;max_output_tokens?:number;checked_at?:string;state?:string}};
};
export type BootstrapSettings = {
  version?: string;
  account?: { id: string; name: string; audience?: string; positioning?: string; library_root?: string;
    columns?: Array<{code:string;name:string}> };
  accounts?: Array<{id:string;name:string}>;
  account_hash?: string;
  routes_hash?: string;
  credential_warning?: string | null;
  settings?: { profiles: ModelProfile[]; routes?: Record<string, ModelRoute> };
};

export function useBootstrap() {
  return useAccountQuery<BootstrapSettings>("bootstrap", {}, { staleTime: 60_000 });
}

/** Readiness follows the same writer primary/fallback chain used by the real request. */
export function useModelReadiness() {
  const boot = useBootstrap();
  return writingReadiness(boot.data?.settings);
}

