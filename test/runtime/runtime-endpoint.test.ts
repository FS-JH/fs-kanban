import { afterEach, describe, expect, it } from "vitest";

import {
	buildKanbanRuntimeBindUrl,
	buildKanbanRuntimeUrl,
	buildKanbanRuntimeWsUrl,
	DEFAULT_KANBAN_RUNTIME_PORT,
	getKanbanRuntimeAdvertisedHost,
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
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
});
