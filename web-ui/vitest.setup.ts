class MockIntersectionObserver implements IntersectionObserver {
	readonly root: Element | Document | null = null;
	readonly rootMargin = "";
	readonly thresholds = [0];

	disconnect(): void {}

	observe(_target: Element): void {}

	takeRecords(): IntersectionObserverEntry[] {
		return [];
	}

	unobserve(_target: Element): void {}
}

Object.defineProperty(globalThis, "IntersectionObserver", {
	writable: true,
	configurable: true,
	value: MockIntersectionObserver,
});

class MockStorage implements Storage {
	private readonly store = new Map<string, string>();

	get length(): number {
		return this.store.size;
	}

	clear(): void {
		this.store.clear();
	}

	getItem(key: string): string | null {
		return this.store.get(key) ?? null;
	}

	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null;
	}

	removeItem(key: string): void {
		this.store.delete(key);
	}

	setItem(key: string, value: string): void {
		this.store.set(key, value);
	}
}

if (typeof window !== "undefined") {
	const storage = new MockStorage();
	Object.defineProperty(window, "localStorage", {
		writable: true,
		configurable: true,
		value: storage,
	});
	Object.defineProperty(globalThis, "localStorage", {
		writable: true,
		configurable: true,
		value: storage,
	});
}
