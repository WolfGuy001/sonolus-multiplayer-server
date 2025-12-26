import fs from 'fs';
import path from 'path';
import { ResultEntry } from './types';
import { Sil } from '@sonolus/core';

const DATA_FILE = path.join(__dirname, 'matches_history.json');

export type MatchRecord = {
    id: string;
    timestamp: number;
    roomName: string;
    level: Sil;
    results: ResultEntry[];
}

export class ResultsStore {
    private history: MatchRecord[] = [];

    constructor() {
        this.load();
    }

    private load() {
        if (fs.existsSync(DATA_FILE)) {
            try {
                const data = fs.readFileSync(DATA_FILE, 'utf-8');
                this.history = JSON.parse(data);
            } catch (e) {
                console.error("Failed to load match history:", e);
                this.history = [];
            }
        }
    }

    private save() {
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(this.history, null, 2));
        } catch (e) {
            console.error("Failed to save match history:", e);
        }
    }

    public addMatch(roomName: string, level: Sil | null, results: ResultEntry[]) {
        if (!level || results.length === 0) return;

        const record: MatchRecord = {
            id: Date.now().toString(),
            timestamp: Date.now(),
            roomName,
            level,
            results
        };

        this.history.unshift(record); // Newest first
        // Limit history size if needed, e.g. keep last 1000 matches
        if (this.history.length > 1000) {
            this.history = this.history.slice(0, 1000);
        }
        this.save();
    }

    public getHistory(): MatchRecord[] {
        return this.history;
    }

    public clearHistory() {
        this.history = [];
        this.save();
    }
}

export const resultsStore = new ResultsStore();
