import { ServiceUserId, Sil } from '@sonolus/core'

export type RoomStatus = 'selecting' | 'preparing' | 'playing'
export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

export type ChatMessage = {
    userId: ServiceUserId | null
    type: 'text' | 'quick'
    value: string
}

export type GameplayResult = {
    grade: 'allPerfect' | 'fullCombo' | 'pass' | 'fail'
    arcadeScore: number
    accuracyScore: number
    combo: number
    perfect: number
    great: number
    good: number
    miss: number
    totalCount: number
}

export type ScoreEntry = {
    userId: ServiceUserId
    value: string
}

export type ScoreboardSection = {
    title: string
    icon?: string
    scores: ScoreEntry[]
}

export type ResultEntry = {
    userId: ServiceUserId
    result: GameplayResult
    userName?: string
}

export type UserStatusEntry = {
    userId: ServiceUserId
    status: UserStatus
}

export type Suggestion = {
    userId: ServiceUserId
    level: Sil
}

export type LevelOptionEntry = {
    index: number
    value: number
}
