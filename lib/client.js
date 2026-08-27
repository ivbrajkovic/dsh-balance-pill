// dsh-balance-pill — browser half.
//
// Hand-written client bundle in the shipped `window.__ModuleLoader__.load`
// format (see the packaged client bundles, e.g. dsh-client-ui-jobs): the
// factory registers lazily; materialization happens on first require. The
// package is picked into the browser roster by dsh-client-modules because
// package.json declares `dsh.client` and exports["./client"].
//
// The pill registers into `conversation.session.header.utilities` (additive,
// replaceRisk: none) and polls the Host route on mount, every 60s, and on
// click. It only ever receives { ok, balance, currency } or { ok: false } —
// no key material, no error detail.

window.__ModuleLoader__.load({
	id: "dsh-balance-pill",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		const REFRESH_MS = 60 * 1000;
		const ENDPOINT = "/dsh-balance-pill";
		const PEAK_CHECK_MS = 60 * 1000;

		// ---- Peak-hours configuration ------------------------------------------
		//
		// The config now lives in the settings document, surfaced in the browser
		// Settings → Plugins → Plugin configuration page (see the settings card
		// below). `DEFAULT_PEAK_CONFIG` is only the fallback shown until the Host
		// serves the namespace, and the schema default on the Host. The pill reads
		// the live value (timezone + peakHours) from the settings store and tints
		// itself red during a peak range and green otherwise.
		//
		// `peakHours` is an array of `[start, end]` wall-clock ranges, and
		// `timezone` is the IANA timezone those strings are written in (e.g.
		// "UTC", "Asia/Shanghai", "America/New_York"). The ranges are interpreted
		// in `timezone`, converted to the user's browser-determined local
		// timezone, then checked against the user's current local time. A range is
		// inclusive of its start and exclusive of its end; a range whose end is at
		// or before its start wraps across midnight to the next day (so
		// ["23:00", "01:00"] spans that whole window).
		const SETTINGS_NAMESPACE = "dsh-balance-pill";
		const DEFAULT_PEAK_CONFIG = {
			timezone: "UTC",
			peakHours: [
				["01:00", "04:00"],
				["06:00", "10:00"],
			],
		};

		// ---- Timezone / peak helpers (pure, testable) --------------------------

		/** Parse "HH:MM" into { hour, minute }, or null when invalid. */
		function parseHHMM(value) {
			const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
			if (!match) return null;
			const hour = Number(match[1]);
			const minute = Number(match[2]);
			if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
			return { hour, minute };
		}

		/** The user's local IANA timezone, as reported by the browser. */
		function userLocalTimeZone() {
			try {
				return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
			} catch {
				return "UTC";
			}
		}

		/** Format an instant into parts for a given timezone (h23 avoids "24"). */
		function partsIn(timeZone, epochMs, extra) {
			const formatter = new Intl.DateTimeFormat(
				"en-US",
				Object.assign({ timeZone, hourCycle: "h23" }, extra)
			);
			const map = {};
			for (const part of formatter.formatToParts(new Date(epochMs))) map[part.type] = part.value;
			return map;
		}

		/** UTC offset (minutes, sign UTC+n is positive) of `timeZone` at `epochMs`. */
		function offsetMinutes(epochMs, timeZone) {
			const p = partsIn(timeZone, epochMs, {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
			const asUTC = Date.UTC(
				Number(p.year),
				Number(p.month) - 1,
				Number(p.day),
				Number(p.hour) % 24,
				Number(p.minute),
				Number(p.second)
			);
			return (asUTC - epochMs) / 60000;
		}

		/** Civil date (year/month/day) of `epochMs` in `timeZone`. */
		function civilDate(epochMs, timeZone) {
			const p = partsIn(timeZone, epochMs, { year: "numeric", month: "2-digit", day: "2-digit" });
			return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
		}

		/** Shift a civil date by `n` days (pure calendar arithmetic). */
		function addDays(date, n) {
			const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + n));
			return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
		}

		/**
		 * Convert a wall-clock date+time in `timeZone` to a UTC epoch (ms). Runs
		 * Intl twice so a DST transition on the boundary resolves correctly.
		 */
		function zonedToInstant(year, month, day, hour, minute, timeZone) {
			const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
			const offset1 = offsetMinutes(target, timeZone);
			let instant = target - offset1 * 60000;
			const offset2 = offsetMinutes(instant, timeZone);
			if (offset2 !== offset1) instant = target - offset2 * 60000;
			return instant;
		}

		/**
		 * Whether `nowMs` falls inside any configured peak range, evaluated in the
		 * config timezone. Candidate days span yesterday..tomorrow so midnight-
		 * crossing ranges that overlap `now` are caught.
		 */
		function isPeakNow(nowMs, config) {
			const timeZone =
				typeof config.timezone === "string" && config.timezone.length > 0
					? config.timezone
					: "UTC";
			const ranges = Array.isArray(config.peakHours) ? config.peakHours : [];
			if (ranges.length === 0) return false;
			const today = civilDate(nowMs, timeZone);
			const candidates = [addDays(today, -1), today, addDays(today, 1)];
			for (const range of ranges) {
				const start = parseHHMM(range[0]);
				const end = parseHHMM(range[1]);
				if (!start || !end) continue;
				for (const day of candidates) {
					const startInstant = zonedToInstant(day.year, day.month, day.day, start.hour, start.minute, timeZone);
					const crossesMidnight =
						end.hour < start.hour || (end.hour === start.hour && end.minute <= start.minute);
					const endDay = crossesMidnight ? addDays(day, 1) : day;
					const endInstant = zonedToInstant(endDay.year, endDay.month, endDay.day, end.hour, end.minute, timeZone);
					if (nowMs >= startInstant && nowMs < endInstant) return true;
				}
			}
			return false;
		}

		/**
		 * Observable store over the peak-hours settings section. The pill reads the
		 * snapshot (timezone + peakHours) to tint itself; the settings card reads
		 * and writes the same store, so both stay in sync. `attach` binds a Host
		 * settings scope and folds its snapshot into this store.
		 */
		function createPeakConfigStore() {
			let state = {
				status: "loading",
				timezone: DEFAULT_PEAK_CONFIG.timezone,
				peakHours: DEFAULT_PEAK_CONFIG.peakHours,
				writable: false,
			};
			let scope;
			const listeners = new Set();
			const emit = () => {
				for (const listener of listeners) listener();
			};
			const publish = (next) => {
				const same =
					next.status === state.status &&
					next.timezone === state.timezone &&
					next.writable === state.writable &&
					JSON.stringify(next.peakHours) === JSON.stringify(state.peakHours);
				if (same) return;
				state = next;
				emit();
			};
			return {
				store: {
					subscribe(listener) {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					},
					getSnapshot() {
						return state;
					},
				},
				attach(bound) {
					scope = bound;
					const sync = () => {
						const snap = bound.getSnapshot();
						const raw = snap.value;
						publish({
							status: snap.status === "ready" || snap.status === "unavailable" ? snap.status : "loading",
							timezone:
								raw && typeof raw.timezone === "string"
									? raw.timezone
									: DEFAULT_PEAK_CONFIG.timezone,
							peakHours:
								raw && Array.isArray(raw.peakHours)
									? raw.peakHours
									: DEFAULT_PEAK_CONFIG.peakHours,
							writable: snap.writable === true,
						});
					};
					sync();
					return bound.subscribe(sync);
				},
				set(field, value) {
					if (scope === void 0) return;
					if (field === "timezone" && typeof value === "string") {
						publish({ ...state, timezone: value });
					} else if (field === "peakHours" && Array.isArray(value)) {
						publish({ ...state, peakHours: value });
					}
					scope.set(field, value);
				},
			};
		}

		/** Serialize a peak-hours range set for the textarea. */
		function formatPeakHours(lines) {
			return lines.map((range) => range[0] + " - " + range[1]).join("\n");
		}

		/**
		 * Parse the peak-hours textarea ("HH:MM - HH:MM" one per line) into a
		 * range set, or null when any line is malformed.
		 */
		function parsePeakHours(text) {
			const out = [];
			for (const line of String(text).split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				const match = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/.exec(trimmed.replace(/\s+/g, " "));
				if (!match) return null;
				if (parseHHMM(match[1]) === null || parseHHMM(match[2]) === null) return null;
				out.push([match[1], match[2]]);
			}
			return out;
		}

		/** A 14px chevron-down outline, matching the plugin-config cards' disclosure icon. */
		function ChevronDownIcon({ open }) {
			return react.createElement(
				"svg",
				{
					className: "dsh-balance-pill-card-chevron" + (open ? " dsh-balance-pill-card-chevron-open" : ""),
					width: 14,
					height: 14,
					viewBox: "0 0 14 14",
					fill: "none",
					"aria-hidden": true,
				},
				react.createElement("path", {
					d: "M3.5 5.25 7 8.75l3.5-3.5",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				})
			);
		}

		/**
		 * The settings card rendered in Settings → Plugins → Plugin configuration,
		 * styled like the shipped plugin-config cards: a bordered rounded card whose
		 * header is a disclosure button (name + description on the left, a rotating
		 * chevron on the right). It edits the `timezone` and `peakHours` fields
		 * through the injected `set` action and reflects the persisted config
		 * through the injected `usePeakConfig` hook. Returns null while the
		 * namespace is not served.
		 */
		function makeSettingsCard(peak) {
			return function SettingsCard(props) {
				const config = typeof props.usePeakConfig === "function" ? props.usePeakConfig((s) => s) : void 0;
				const [open, setOpen] = react.useState(false);
				const [timezoneDraft, setTimezoneDraft] = react.useState("");
				const [rangesDraft, setRangesDraft] = react.useState("");
				const [error, setError] = react.useState(null);
				const [saved, setSaved] = react.useState(false);
				react.useEffect(() => {
					if (config === void 0) return;
					setTimezoneDraft(config.timezone);
					setRangesDraft(formatPeakHours(config.peakHours));
				}, [config === void 0 ? "none" : config.timezone, config === void 0 ? "[]" : JSON.stringify(config.peakHours)]);
				if (config === void 0 || config.status === "unavailable") return null;
				const readonly = config.status !== "ready" || !config.writable;
				const apply = () => {
					const parsed = parsePeakHours(rangesDraft);
					if (parsed === null) {
						setError("Use one range per line as HH:MM - HH:MM (e.g. 01:00 - 04:00).");
						setSaved(false);
						return;
					}
					const timezone = timezoneDraft.trim();
					setError(null);
					props.set("timezone", timezone === "" ? "UTC" : timezone);
					props.set("peakHours", parsed);
					setSaved(true);
				};
				const discard = () => {
					setTimezoneDraft(config.timezone);
					setRangesDraft(formatPeakHours(config.peakHours));
					setError(null);
					setSaved(false);
				};
				return react.createElement(
					"li",
					{ className: "dsh-balance-pill-card" + (open ? " dsh-balance-pill-card-open" : "") },
					react.createElement(
						"button",
						{
							type: "button",
							className: "dsh-balance-pill-card-head",
							"aria-expanded": open,
							"aria-label": (open ? "Hide settings: " : "Show settings: ") + "Balance pill peak hours",
							onClick: () => setOpen((v) => !v),
						},
						react.createElement(
							"span",
							{ className: "dsh-balance-pill-card-headtext" },
							react.createElement("span", { className: "dsh-balance-pill-card-name" }, "Balance pill peak hours"),
							react.createElement(
								"span",
								{ className: "dsh-balance-pill-card-desc" },
								"Peak-hour window that tints the balance pill red / green."
							)
						),
						react.createElement(ChevronDownIcon, { open })
					),
					open
						? react.createElement(
								"div",
								{ className: "dsh-balance-pill-card-body" },
								readonly
									? react.createElement("p", { className: "dsh-balance-pill-card-note", role: "status" }, "This deployment stores settings read-only.")
									: null,
								react.createElement(
									"label",
									{ className: "dsh-balance-pill-card-field", htmlFor: "dsh-balance-pill-timezone" },
									"Timezone",
									react.createElement("input", {
										id: "dsh-balance-pill-timezone",
										className: "dsh-balance-pill-card-input",
										type: "text",
										value: timezoneDraft,
										placeholder: "UTC",
										onChange: (event) => setTimezoneDraft(event.target.value),
									})
								),
								react.createElement(
									"label",
									{ className: "dsh-balance-pill-card-field", htmlFor: "dsh-balance-pill-peakhours" },
									"Peak hours (one range per line)",
									react.createElement("textarea", {
										id: "dsh-balance-pill-peakhours",
										className: "dsh-balance-pill-card-input",
										rows: 3,
										value: rangesDraft,
										placeholder: "01:00 - 04:00\n06:00 - 10:00",
										onChange: (event) => setRangesDraft(event.target.value),
									})
								),
								error !== null
									? react.createElement("p", { className: "dsh-balance-pill-card-error", role: "status" }, error)
									: null,
								react.createElement(
									"div",
									{ className: "dsh-balance-pill-card-footer" },
									saved
										? react.createElement("p", { className: "dsh-balance-pill-card-hint", role: "status" }, "Saved.")
										: null,
									react.createElement(
										"button",
										{ type: "button", className: "dsh-balance-pill-card-discard", onClick: discard },
										"Discard"
									),
									react.createElement(
										"button",
										{ type: "button", className: "dsh-balance-pill-card-save", disabled: readonly, onClick: apply },
										"Save"
									)
								)
							)
						: null
				);
			};
		}

		/**
		 * The always-visible pill: `CNY 42.17` when loaded, a muted neutral mark
		 * while loading or after any failure. Clicking refreshes at once. It reads
		 * the peak-hours config from the shared settings store and tints the button
		 * red during a peak range and green otherwise.
		 * @param store - the peak-config snapshot store.
		 * @returns the pill component.
		 */
		function makeBalancePill(store) {
			return function BalancePill() {
				const [state, setState] = react.useState({ kind: "loading" });
				const config = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
				const [peak, setPeak] = react.useState({ running: false, timeZone: "UTC" });
				const refresh = react.useCallback(async () => {
					let next;
					try {
						const response = await fetch(ENDPOINT, { cache: "no-store" });
						const data = await response.json();
						if (data && data.ok === true && typeof data.balance === "number") {
							next = {
								kind: "ok",
								balance: data.balance,
								currency: typeof data.currency === "string" ? data.currency : "",
							};
						} else {
							next = { kind: "error" };
						}
					} catch (error) {
						next = { kind: "error" };
					}
					setState(next);
				}, []);
				react.useEffect(() => {
					refresh();
					const timer = setInterval(refresh, REFRESH_MS);
					return () => clearInterval(timer);
				}, [refresh]);
				// Recompute the peak/off-peak status on the browser's clock (not the
				// balance fetch) so the tint stays correct as time passes, and re-run
				// whenever the persisted config changes.
				const configKey = config.timezone + "|" + JSON.stringify(config.peakHours) + "|" + config.status;
				react.useEffect(() => {
					const checkPeak = () => {
						let running = false;
						let timeZone = "UTC";
						try {
							timeZone = userLocalTimeZone();
							running = config.status === "unavailable" ? false : isPeakNow(Date.now(), { timezone: config.timezone, peakHours: config.peakHours });
						} catch {
							running = false;
						}
						setPeak({ running, timeZone });
					};
					checkPeak();
					const timer = setInterval(checkPeak, PEAK_CHECK_MS);
					return () => clearInterval(timer);
				}, [configKey]);
				let title = "DeepSeek balance";
				let content;
				if (state.kind === "ok") {
					const peakLabel = peak.running ? "peak hours" : "off-peak";
					title = "DeepSeek balance · " + peakLabel + " — click to refresh";
					const amount = state.balance.toFixed(2);
					content = [];
					if (state.currency.length > 0) {
						content.push(react.createElement("span", { className: "dsh-balance-pill-cur", key: "cur" }, state.currency));
					}
					content.push(react.createElement("span", { className: "dsh-balance-pill-amt", key: "amt" }, amount));
				} else if (state.kind === "loading") {
					title = "Loading balance…";
					content = "…";
				} else {
					title = "Balance unavailable — click to retry";
					content = "–";
				}
				return react.createElement(
					"button",
					{
						type: "button",
						onClick: refresh,
						title,
						className: "dsh-balance-pill" + (peak.running ? " dsh-balance-pill--peak" : " dsh-balance-pill--offpeak"),
						"aria-label": "DeepSeek balance",
					},
					content
				);
			};
		}

		// One stylesheet for this package, injected once per page (guarded by a
		// data-plugin-css tag, matching the shipped client-bundle pattern) and
		// themed with the product's CSS variables.
		const CSS_TAG = "dsh-balance-pill/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-pill";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = [
				".dsh-balance-pill{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;user-select:none}",
				".dsh-balance-pill:hover{color:var(--dsw-alias-label-primary)}",
				".dsh-balance-pill:active{opacity:.8}",
				".dsh-balance-pill-cur{font-size:11px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;font-variant-numeric:tabular-nums}",
				".dsh-balance-pill-amt{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}",
				".dsh-balance-pill--peak{background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,var(--dsw-alias-state-error-primary) 12%);border-color:var(--dsw-alias-border-l1);border-color:color-mix(in srgb,var(--dsw-alias-border-l1) 70%,var(--dsw-alias-state-error-primary) 30%);color:var(--dsw-alias-state-error-primary)}",
				".dsh-balance-pill--peak .dsh-balance-pill-cur{color:var(--dsw-alias-state-error-primary)}",
				".dsh-balance-pill--peak .dsh-balance-pill-amt{color:var(--dsw-alias-state-error-primary)}",
				".dsh-balance-pill--offpeak{background:var(--dsw-alias-bg-layer-2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,var(--dsw-alias-state-success-primary) 12%);border-color:var(--dsw-alias-border-l1);border-color:color-mix(in srgb,var(--dsw-alias-border-l1) 70%,var(--dsw-alias-state-success-primary) 30%);color:var(--dsw-alias-state-success-primary)}",
				".dsh-balance-pill--offpeak .dsh-balance-pill-cur{color:var(--dsw-alias-state-success-primary)}",
				".dsh-balance-pill--offpeak .dsh-balance-pill-amt{color:var(--dsw-alias-state-success-primary)}",
				"@media (max-width:600px){.dsh-balance-pill{height:26px;padding:0 10px;font-size:12px;gap:4px}.dsh-balance-pill-cur{font-size:10px}}",
				".dsh-balance-pill-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
				".dsh-balance-pill-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
				".dsh-balance-pill-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
				".dsh-balance-pill-card-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
				".dsh-balance-pill-card-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
				".dsh-balance-pill-card-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
				".dsh-balance-pill-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
				".dsh-balance-pill-card-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
				".dsh-balance-pill-card-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
				".dsh-balance-pill-card-chevron-open{transform:rotate(180deg)}",
				".dsh-balance-pill-card-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:10px 0 8px;display:flex;flex-direction:column;gap:10px}",
				".dsh-balance-pill-card-field{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px}",
				".dsh-balance-pill-card-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px}",
				".dsh-balance-pill-card-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
				".dsh-balance-pill-card-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px}",
				".dsh-balance-pill-card-note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}",
				".dsh-balance-pill-card-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
				".dsh-balance-pill-card-hint{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}",
				".dsh-balance-pill-card-save,.dsh-balance-pill-card-discard{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
				".dsh-balance-pill-card-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
				".dsh-balance-pill-card-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
				".dsh-balance-pill-card-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
				".dsh-balance-pill-card-save:disabled,.dsh-balance-pill-card-discard:disabled{opacity:.4;cursor:default}",
				".dsh-balance-pill-card-save:focus-visible,.dsh-balance-pill-card-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			].join("");
			document.head.appendChild(tag);
		}

		/** Required services: the slot registry the header seat lives on. */
		const inject = ["slots"];

		/**
		 * Client plugin body: contribute the pill to the session-header utilities
		 * seat (additive, replaceRisk none) and register the peak-hours settings
		 * card into the Plugins configuration page. The pill reads the same
		 * settings store the card writes, so a change retints the pill.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const peak = createPeakConfigStore();
			const BalancePill = makeBalancePill(peak.store);
			ctx.slots.inject("conversation.session.header.utilities", () =>
				ctx.slots.register(
					{ name: "conversation.session.header.utilities", id: "balance-pill", order: 10 },
					BalancePill
				)
			);
			// Bind the Host settings scope once available, then register the card
			// that edits it. The card only renders when the Host serves the
			// namespace (see the Plugins configuration tab's dispatch).
			ctx.inject(["settingsScope"], (raw) => {
				const binder = raw.settingsScope;
				if (binder === void 0) return;
				const scope = binder.bind({ namespace: SETTINGS_NAMESPACE });
				ctx.effect(() => peak.attach(scope), "dsh-balance-pill: settings scope");
				const SettingsCard = makeSettingsCard(peak);
				ctx.slots.inject("settings.plugin.item", () =>
					ctx.slots.register(
						{
							name: "settings.plugin.item",
							key: SETTINGS_NAMESPACE,
							inject: () => ({
								hooks: { peakConfig: peak.store },
								set: (field, value) => {
									peak.set(field, value);
								},
							}),
						},
						(props) => react.createElement(SettingsCard, props)
					)
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
