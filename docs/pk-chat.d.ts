/* PlaneKey chat — persistent multi-channel messaging panel.
 * Verbatim production script (planekey-app/js/chat.js); these typings
 * document its contract. It self-mounts on load: a FAB (bottom-right,
 * with unread-count badge) that opens a five-channel side panel. */

export interface PkChatChannels {
  /** AI — user's own provider key via PKBridge 'ai_proxy_completion' (desktop/Tauri only; browser shows a setup hint). */
  ai: void;
  /** Docs — grounded keyword search over pages/docs.html; ranked excerpt + anchor link, no LLM. */
  docs: void;
  /** Direct — E2EE Burrow send (CosmicID 144-hex recipient + bridge UUID, hop/run/vault tier picker, local-only contacts book). */
  direct: void;
  /** Inbox — read-only warren inbox; click a message to fetch + decrypt (desktop) and ack. Feeds the FAB unread badge. */
  inbox: void;
  /** Settings — login-sensitive surfaces (Account / Settings / Billing / GitHub App) + sign in/out. */
  settings: void;
}

export interface PkChatIntegration {
  /** Mount guard: skipped inside the app shell's content frame (window.name === 'pk-content-frame') and when localStorage pk_chat_disabled === '1'. */
  mountRules: void;
  /** localStorage: pk_chat_history_v2 (per-channel log, capped 200), pk_chat_state_v2 (open/channel/recipient), pk_chat_contacts_v1 (local address book). */
  storage: void;
  /** Auth echo: reflects pk_bridge_token; 'pk-auth-changed' window event fires the green unlock ring on the FAB; desaturated while signed out. */
  auth: void;
  /** Unread badge: polls /v1/transport/warren/inbox every 45s when an account id is known (window.PK_ACCOUNT_ID or PKBridge pkclient_status). */
  notifications: void;
  /** window.__PK_CHAT_OPEN_INBOX__(observationId?) — open the panel on Inbox and optionally auto-decrypt one item. */
  hooks: void;
}

/** VSE adaptation: channels backed by pk-client subcommands */
export interface PkChatVseBindings {
  /** ai_completion  → pk-client ai proxy completion --prompt <p> --json */
  ai: string;
  /** docs_search    → pk-client docs search <q> --json */
  docs: string;
  /** direct_send    → pk-client burrow send <recipient> <text> --tier <tier> --json */
  direct: string;
  /** inbox_fetch    → pk-client warren inbox --json */
  inbox: string;
  /** inbox_decrypt  → pk-client warren decrypt <id> --json */
  decrypt: string;
  /** trust_status   → pk-client trust state --json */
  trust: string;
}
