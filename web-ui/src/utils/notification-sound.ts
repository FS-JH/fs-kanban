let sharedAudioContext: AudioContext | null = null;
let lastNotificationSoundAt = 0;

function getAudioContextConstructor(): typeof AudioContext | undefined {
	if (typeof window === "undefined") {
		return undefined;
	}
	return window.AudioContext ?? undefined;
}

function getSharedAudioContext(): AudioContext | null {
	const AudioContextConstructor = getAudioContextConstructor();
	if (!AudioContextConstructor) {
		return null;
	}
	if (sharedAudioContext) {
		return sharedAudioContext;
	}
	try {
		sharedAudioContext = new AudioContextConstructor();
		return sharedAudioContext;
	} catch {
		return null;
	}
}

function scheduleTone(context: AudioContext, startTime: number, frequency: number, durationMs: number): void {
	const oscillator = context.createOscillator();
	const gainNode = context.createGain();
	oscillator.type = "sine";
	oscillator.frequency.value = frequency;
	gainNode.gain.setValueAtTime(0.0001, startTime);
	gainNode.gain.exponentialRampToValueAtTime(0.06, startTime + 0.01);
	gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + durationMs / 1_000);
	oscillator.connect(gainNode);
	gainNode.connect(context.destination);
	oscillator.start(startTime);
	oscillator.stop(startTime + durationMs / 1_000 + 0.02);
}

export function playAgentAttentionSound(): void {
	const now = Date.now();
	if (now - lastNotificationSoundAt < 1_000) {
		return;
	}
	lastNotificationSoundAt = now;
	const audioContext = getSharedAudioContext();
	if (!audioContext) {
		return;
	}
	const startTime = audioContext.currentTime + 0.01;
	try {
		scheduleTone(audioContext, startTime, 880, 100);
		scheduleTone(audioContext, startTime + 0.16, 660, 180);
	} catch {
		// Ignore notification sound failures.
	}
}
