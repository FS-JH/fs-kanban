import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildKanbanRuntimeBindUrl,
	buildKanbanRuntimeUrl,
	buildKanbanRuntimeWsUrl,
	DEFAULT_KANBAN_RUNTIME_HOST,
	DEFAULT_KANBAN_RUNTIME_HTTPS_PORT,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeAdvertisedHost,
	getKanbanRuntimeHost,
	getKanbanRuntimeHttpsPort,
	getKanbanRuntimePort,
	isKanbanRuntimeHttpsEnabled,
	parseRuntimePort,
	setKanbanRuntimeAdvertisedHost,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
} from "../../src/core/runtime-endpoint.js";

const originalRuntimePort = getKanbanRuntimePort();
const originalRuntimeHost = getKanbanRuntimeHost();
const originalRuntimeAdvertisedHost = getKanbanRuntimeAdvertisedHost();
const originalEnvPort = process.env.KANBAN_RUNTIME_PORT;
const originalEnvHost = process.env.KANBAN_RUNTIME_HOST;
const originalEnvAdvertisedHost = process.env.KANBAN_RUNTIME_ADVERTISED_HOST;
const originalEnvHttpsPort = process.env.KANBAN_RUNTIME_HTTPS_PORT;
const originalEnvHttpsPortFallback = process.env.HTTPS_PORT;
const originalEnvTlsCert = process.env.KANBAN_RUNTIME_TLS_CERT;
const originalEnvTlsKey = process.env.KANBAN_RUNTIME_TLS_KEY;
const originalEnvTlsCertFallback = process.env.TLS_CERT;
const originalEnvTlsKeyFallback = process.env.TLS_KEY;

beforeEach(() => {
	delete process.env.KANBAN_RUNTIME_TLS_CERT;
	delete process.env.KANBAN_RUNTIME_TLS_KEY;
	delete process.env.TLS_CERT;
	delete process.env.TLS_KEY;
	delete process.env.KANBAN_RUNTIME_HTTPS_PORT;
	delete process.env.HTTPS_PORT;
	setKanbanRuntimeHost(DEFAULT_KANBAN_RUNTIME_HOST);
	setKanbanRuntimeAdvertisedHost(null);
	setKanbanRuntimePort(DEFAULT_KANBAN_RUNTIME_PORT);
});

afterEach(() => {
	setKanbanRuntimePort(originalRuntimePort);
	setKanbanRuntimeHost(originalRuntimeHost);
	setKanbanRuntimeAdvertisedHost(originalRuntimeAdvertisedHost);
	if (originalEnvPort === undefined) {
		delete process.env.KANBAN_RUNTIME_PORT;
	} else {
		process.env.KANBAN_RUNTIME_PORT = originalEnvPort;
	}
	if (originalEnvHost === undefined) {
		delete process.env.KANBAN_RUNTIME_HOST;
	} else {
		process.env.KANBAN_RUNTIME_HOST = originalEnvHost;
	}
	if (originalEnvAdvertisedHost === undefined) {
		delete process.env.KANBAN_RUNTIME_ADVERTISED_HOST;
	} else {
		process.env.KANBAN_RUNTIME_ADVERTISED_HOST = originalEnvAdvertisedHost;
	}
	if (originalEnvHttpsPort === undefined) {
		delete process.env.KANBAN_RUNTIME_HTTPS_PORT;
	} else {
		process.env.KANBAN_RUNTIME_HTTPS_PORT = originalEnvHttpsPort;
	}
	if (originalEnvHttpsPortFallback === undefined) {
		delete process.env.HTTPS_PORT;
	} else {
		process.env.HTTPS_PORT = originalEnvHttpsPortFallback;
	}
	if (originalEnvTlsCert === undefined) {
		delete process.env.KANBAN_RUNTIME_TLS_CERT;
	} else {
		process.env.KANBAN_RUNTIME_TLS_CERT = originalEnvTlsCert;
	}
	if (originalEnvTlsKey === undefined) {
		delete process.env.KANBAN_RUNTIME_TLS_KEY;
	} else {
		process.env.KANBAN_RUNTIME_TLS_KEY = originalEnvTlsKey;
	}
	if (originalEnvTlsCertFallback === undefined) {
		delete process.env.TLS_CERT;
	} else {
		process.env.TLS_CERT = originalEnvTlsCertFallback;
	}
	if (originalEnvTlsKeyFallback === undefined) {
		delete process.env.TLS_KEY;
	} else {
		process.env.TLS_KEY = originalEnvTlsKeyFallback;
	}
});

describe("runtime-endpoint", () => {
	it("parses default port when env value is missing", () => {
		expect(parseRuntimePort(undefined)).toBe(DEFAULT_KANBAN_RUNTIME_PORT);
	});

	it("throws for invalid ports", () => {
		expect(() => parseRuntimePort("0")).toThrow(/Invalid KANBAN_RUNTIME_PORT value/);
		expect(() => parseRuntimePort("70000")).toThrow(/Invalid KANBAN_RUNTIME_PORT value/);
		expect(() => parseRuntimePort("abc")).toThrow(/Invalid KANBAN_RUNTIME_PORT value/);
	});

	it("updates runtime url builders when port changes", () => {
		setKanbanRuntimePort(4567);
		expect(getKanbanRuntimePort()).toBe(4567);
		expect(process.env.KANBAN_RUNTIME_PORT).toBe("4567");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("http://127.0.0.1:4567/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/terminal/ws")).toBe("ws://127.0.0.1:4567/api/terminal/ws");
	});

	it("updates runtime url builders when host changes", () => {
		setKanbanRuntimeHost("100.64.0.1");
		setKanbanRuntimePort(4567);
		expect(getKanbanRuntimeHost()).toBe("100.64.0.1");
		expect(getKanbanRuntimeAdvertisedHost()).toBe("100.64.0.1");
		expect(process.env.KANBAN_RUNTIME_HOST).toBe("100.64.0.1");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("http://100.64.0.1:4567/api/trpc");
		expect(buildKanbanRuntimeBindUrl("/api/trpc")).toBe("http://100.64.0.1:4567/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/terminal/ws")).toBe("ws://100.64.0.1:4567/api/terminal/ws");
	});

	it("keeps public URLs on the advertised host while local API calls stay on the bind host", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimeAdvertisedHost("foundation-ea.tailnet.ts.net");
		setKanbanRuntimePort(4567);
		expect(getKanbanRuntimeHost()).toBe("0.0.0.0");
		expect(getKanbanRuntimeAdvertisedHost()).toBe("foundation-ea.tailnet.ts.net");
		expect(process.env.KANBAN_RUNTIME_ADVERTISED_HOST).toBe("foundation-ea.tailnet.ts.net");
		expect(buildKanbanRuntimeBindUrl("/api/trpc")).toBe("http://0.0.0.0:4567/api/trpc");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("http://foundation-ea.tailnet.ts.net:4567/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/runtime/ws")).toBe("ws://foundation-ea.tailnet.ts.net:4567/api/runtime/ws");
	});

	it("switches advertised URLs to HTTPS when TLS env is configured", () => {
		setKanbanRuntimeHost("0.0.0.0");
		setKanbanRuntimeAdvertisedHost("foundation-ea.tailnet.ts.net");
		setKanbanRuntimePort(4567);
		process.env.KANBAN_RUNTIME_TLS_CERT = "/tmp/kanban.crt";
		process.env.KANBAN_RUNTIME_TLS_KEY = "/tmp/kanban.key";
		process.env.KANBAN_RUNTIME_HTTPS_PORT = "4443";

		expect(isKanbanRuntimeHttpsEnabled()).toBe(true);
		expect(getKanbanRuntimeHttpsPort()).toBe(4443);
		expect(buildKanbanRuntimeBindUrl("/api/trpc")).toBe("http://0.0.0.0:4567/api/trpc");
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("https://foundation-ea.tailnet.ts.net:4443/api/trpc");
		expect(buildKanbanRuntimeWsUrl("api/runtime/ws")).toBe("wss://foundation-ea.tailnet.ts.net:4443/api/runtime/ws");
	});

	it("falls back to the bind host when the advertised host is cleared", () => {
		setKanbanRuntimeHost("100.64.0.1");
		setKanbanRuntimeAdvertisedHost("foundation-ea.tailnet.ts.net");
		setKanbanRuntimeAdvertisedHost(null);
		expect(getKanbanRuntimeAdvertisedHost()).toBe("100.64.0.1");
		expect(process.env.KANBAN_RUNTIME_ADVERTISED_HOST).toBeUndefined();
		expect(buildKanbanRuntimeUrl("/api/trpc")).toBe("http://100.64.0.1:3484/api/trpc");
	});

	it("defaults host to 127.0.0.1", () => {
		expect(getKanbanRuntimeHost()).toBe("127.0.0.1");
		expect(getKanbanRuntimeAdvertisedHost()).toBe("127.0.0.1");
	});

	it("defaults the HTTPS port when TLS is enabled without an explicit port", () => {
		process.env.KANBAN_RUNTIME_TLS_CERT = "/tmp/kanban.crt";
		process.env.KANBAN_RUNTIME_TLS_KEY = "/tmp/kanban.key";

		expect(isKanbanRuntimeHttpsEnabled()).toBe(true);
		expect(getKanbanRuntimeHttpsPort()).toBe(DEFAULT_KANBAN_RUNTIME_HTTPS_PORT);
	});
});
