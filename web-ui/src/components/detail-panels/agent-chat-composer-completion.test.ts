import { describe, expect, it } from "vitest";

import {
	applyAgentComposerCompletion,
	buildMentionInsertText,
	buildSlashCommandInsertText,
	detectActiveAgentComposerToken,
} from "@/components/detail-panels/agent-chat-composer-completion";

describe("agent-chat-composer-completion", () => {
	it("detects active mention tokens at the cursor", () => {
		expect(detectActiveAgentComposerToken("Review @src/comp", "Review @src/comp".length)).toEqual({
			kind: "mention",
			start: 7,
			end: 16,
			query: "src/comp",
		});
	});

	it("detects active slash tokens at the start of the draft", () => {
		expect(detectActiveAgentComposerToken("/con", 4)).toEqual({
			kind: "slash",
			start: 0,
			end: 4,
			query: "con",
		});
	});

	it("ignores inline markers that are not token boundaries", () => {
		expect(detectActiveAgentComposerToken("foo/bar", "foo/bar".length)).toBeNull();
		expect(detectActiveAgentComposerToken("mail@test", "mail@test".length)).toBeNull();
	});

	it("formats mention insert text with quotes when needed", () => {
		expect(buildMentionInsertText("src/app.ts")).toBe("@/src/app.ts");
		expect(buildMentionInsertText("docs/my file.md")).toBe('@"/docs/my file.md"');
	});

	it("formats slash command insert text", () => {
		expect(buildSlashCommandInsertText("config")).toBe("/config");
	});

	it("applies a completion and preserves trailing content", () => {
		const token = detectActiveAgentComposerToken("/con next", 4);
		expect(token).not.toBeNull();
		const next = applyAgentComposerCompletion("/con next", token!, "/config");
		expect(next).toEqual({
			value: "/config next",
			cursor: 7,
		});
	});
});
