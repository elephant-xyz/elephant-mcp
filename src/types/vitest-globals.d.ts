declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => unknown | Promise<unknown>): void;
declare function beforeEach(fn: () => unknown | Promise<unknown>): void;
declare function afterEach(fn: () => unknown | Promise<unknown>): void;

type ExpectMatchers = {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
};

declare function expect(actual: unknown): ExpectMatchers;

interface ViMock<TArgs extends unknown[] = unknown[], TReturn = unknown> {
    mockImplementation(impl: (...args: TArgs) => TReturn): void;
}

interface ViAPI {
    fn<T extends (...args: unknown[]) => unknown>(impl?: T): ViMock;
    mock(moduleName: string, factory?: () => unknown): void;
    resetAllMocks(): void;
    restoreAllMocks(): void;
}

declare const vi: ViAPI;


