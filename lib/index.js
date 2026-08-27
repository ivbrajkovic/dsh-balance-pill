// dsh-balance-pill — Host half.
//
// Registers one exact route on the existing `webServer` service (the browser
// HTTP carrier, row `webserver`). The browser half of this package fetch()es
// that same-origin route; the API key never crosses the transport.
//
// The Host half also registers ONE settings namespace (`dsh-balance-pill`) with
// a schemastery schema holding the peak-hours configuration (`timezone` +
// `peakHours`). The settings service persists it to the profile's settings
// document and serves it to the browser, which edits it through the
// Plugins → Plugin configuration card and reads it to tint the pill.
//
// Security posture:
//   - The key is resolved per request via the `credentials` service
//     (`DEEPSEEK_API_KEY`, layered over process env, $DSH_HOME/.credentials.yaml,
//     and .env fallbacks by the credentials provider). It exists only inside
//     this process, in the local variable used to build the Authorization
//     header for the single outgoing call, and only for the duration of that
//     call. It is never logged, persisted, serialized, or returned.
//   - The browser only ever receives { ok: true, balance, currency } or
//     { ok: false } — no key material, no error detail.
//   - The only external destination is GET https://api.deepseek.com/user/balance.

import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import schemastery from "@deepseek-ai/schemastery";

const name = "balance-pill";

const inject = ["credentials", "webServer"];

/** Settings namespace shared by the Host registration and the browser card. */
const SETTINGS_NAMESPACE = "dsh-balance-pill";
/** Defaults shown before the user overrides them (used as the schema defaults). */
const DEFAULT_PEAK_CONFIG = {
	timezone: "UTC",
	peakHours: [
		["01:00", "04:00"],
		["06:00", "10:00"],
	],
};
/**
 * The settings section schema: also the wire envelope the browser scope
 * validates against. A peak-hours range is a `[start, end]` "HH:MM" pair
 * interpreted in `timezone`.
 */
const PeakSettingsSchema = schemastery.object({
	timezone: schemastery.string().default(DEFAULT_PEAK_CONFIG.timezone),
	peakHours: schemastery
		.array(schemastery.tuple([schemastery.string(), schemastery.string()]))
		.default(DEFAULT_PEAK_CONFIG.peakHours),
});

/** The only external network destination the plugin uses. */
const BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
/** Same-origin route the browser half polls. */
const ROUTE_PATH = "/dsh-balance-pill";
/** Upper bound for one upstream call; an abort reads as a neutral error. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Resolve the credential and fetch the balance. Every failure — unconfigured
 * key, network error, timeout, non-2xx (including 401/403 invalid key),
 * malformed payload, missing balance_infos — collapses to `{ ok: false }` so
 * the UI shows one neutral error state and never any detail.
 * @param credentials - the `credentials` service.
 * @returns the minimum wire payload the UI needs.
 */
async function readBalance(credentials) {
	const resolved = await credentials.resolve("DEEPSEEK_API_KEY");
	if (resolved === void 0 || resolved.value.length === 0) return { ok: false };
	const response = await fetch(BALANCE_ENDPOINT, {
		method: "GET",
		headers: { Authorization: `Bearer ${resolved.value}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) return { ok: false };
	let payload;
	try {
		payload = await response.json();
	} catch {
		return { ok: false };
	}
	const infos = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
	const info = infos[0];
	if (info === void 0 || info === null) return { ok: false };
	const balance = typeof info.total_balance === "string" ? Number(info.total_balance) : NaN;
	const currency = typeof info.currency === "string" ? info.currency : "";
	if (!Number.isFinite(balance)) return { ok: false };
	return { ok: true, balance, currency };
}

/**
 * Serve the settings namespace while a settings provider is composed; inert
 * otherwise (the browser card only appears once Host serves the namespace).
 * @param ctx - registrant context.
 */
function installSettings(ctx) {
	ctx.inject(["settings"], (sctx) => {
		sctx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), PeakSettingsSchema);
	});
}

/**
 * Mount the route and the settings namespace on this plugin's fiber, so an
 * unload removes them.
 * @param ctx - registrant context carrying the credentials and webServer services.
 */
function apply(ctx) {
	installSettings(ctx);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				res.writeHead(405, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: false }));
				return;
			}
			let body;
			try {
				body = await readBalance(ctx.credentials);
			} catch {
				body = { ok: false };
			}
			res.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(JSON.stringify(body));
		},
	}));
}

export { name, inject, apply };
