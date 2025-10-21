export interface ScriptFunction {
    name: string;
    code: string;
    filePath: string; // absolute path
}

export interface IndexerOptions {
    clonePath?: string;
    fullRescan?: boolean;
}

export interface IndexSummary {
    processedFiles: string[];
    savedFunctions: number;
}

