export type BackupSummary = {
  package_hash: string; created_at: string; app_version: string;
  accounts: Array<{id:string;name:string}>; files: number; bytes: number;
  excluded: string[]; database_checked: boolean; database_schema: number;
  database_target_schema?: number; migration_versions?: number[]; legacy_unverified?: number[];
  file_path?: string; token?: string;
};
export type RestoredBackup = {
  runtime_root: string; destination: string; accounts: Array<{id:string;name:string}>;
  reconnect_required: boolean; restart_required: boolean;
  activation_token?: string; selection_error?: string;
  source_schema?: number; database_schema?: number; migration_versions?: number[];
};
export type RestoredQueue = {runtime_root:string;total:number;tasks:Array<{task_id:string;account_id:string;input_hash:string;title:string}>};
export function backupSize(bytes:number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
