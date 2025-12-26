import { WebSocket } from 'ws'
import { RoomStatus, UserStatus, ChatMessage, GameplayResult, ScoreboardSection, ResultEntry, UserStatusEntry, Suggestion, LevelOptionEntry } from './types'
import { Sil, ServerForm, LevelItem, RoomUser, ServiceUserId } from '@sonolus/core'
import { resultsStore } from './resultsStore'

export class MultiplayerRoom {
    public name: string
    public title: any
    public status: RoomStatus = 'selecting'
    public master: ServiceUserId | null = null
    public lead: ServiceUserId | null = null
    public allowOtherServers = true
    public isSuggestionsLocked = false
    public autoExit: 'off' | 'pass' | 'fullCombo' | 'allPerfect' = 'off'
    public options: ServerForm[] = [{
        type: 'basic',
        title: '#SETTINGS',
        requireConfirmation: false,
        options: []
    }]
    public optionValues = 'type=basic'
    public level: Sil | null = null
    public levelOptions: LevelOptionEntry[] = []
    public suggestions: Suggestion[] = []
    public scoreboardDescription = ''
    public scoreboardSections: ScoreboardSection[] = []
    public results: ResultEntry[] = []
    public users: { user: RoomUser; ws: WebSocket; profile: any; status: UserStatus }[] = []
    private forceFinishTimer: any = null

    constructor(name: string, title: any) {
        this.name = name
        this.title = title
    }

    public addUser(user: RoomUser, profile: any, ws: WebSocket) {
        if (this.users.find(u => u.profile.id === profile.id)) {
            // Already in room, replace connection
            this.users = this.users.filter(u => u.profile.id !== profile.id)
        }

        const newUserEntry = { user, profile, ws, status: 'waiting' as UserStatus }

        const masterChanged = !this.master
        const leadChanged = !this.lead

        if (masterChanged) this.master = profile.id
        if (leadChanged) this.lead = profile.id

        // 1. Send update event to the new user (now with correct master/lead)
        this.sendUpdate(ws, profile.id, newUserEntry)

        // 2. Add to users list
        this.users.push(newUserEntry)

        // 3. Broadcast addUser to OTHERS only
        this.broadcast({
            type: 'addUser',
            user: {
                authentication: user.authentication,
                signature: user.signature
            }
        }, profile.id)

        // 4. Broadcast master/lead updates to OTHERS if they were just set
        if (masterChanged) {
            this.broadcast({ type: 'updateMaster', master: this.master }, profile.id)
        }
        if (leadChanged) {
            this.broadcast({ type: 'updateLead', lead: this.lead }, profile.id)
        }
    }

    public removeUser(userId: ServiceUserId) {
        const userIndex = this.users.findIndex(u => u.profile.id === userId)
        if (userIndex === -1) return

        const removedEntry = this.users[userIndex]
        this.users.splice(userIndex, 1)

        if (this.master === userId) {
            this.master = this.users.length > 0 ? this.users[0].profile.id : null
            this.broadcast({ type: 'updateMaster', master: this.master })
        }
        if (this.lead === userId) {
            this.lead = this.users.length > 0 ? this.users[0].profile.id : null
            this.broadcast({ type: 'updateLead', lead: this.lead })
        }

        this.broadcast({
            type: 'removeUser',
            user: {
                authentication: removedEntry.user.authentication,
                signature: removedEntry.user.signature
            }
        })
    }

    public handleCommand(userId: ServiceUserId, command: any) {
        console.log(`[Room] Handle command: ${command.type} from ${userId}`);
        switch (command.type) {
            case 'addChatMessage':
                this.broadcast({
                    type: 'addChatMessage',
                    message: {
                        ...command.message,
                        userId
                    }
                })
                break
            case 'updateUserStatus':
                this.updateUserStatus(userId, command.status)
                break
            case 'updateStatus':
                console.log(`[Room] Attempting updateStatus. Master: ${this.master}, Requestor: ${userId}, New Status: ${command.status}`);
                if (this.master === userId) {
                    this.status = command.status
                    this.broadcast({ type: 'updateStatus', status: this.status })
                    if (this.status === 'playing') {
                        console.log('[Room] Match started! Broadcasting startRound...');
                        this.results = []

                        // Set all skipped users to waiting
                        this.users.forEach(u => {
                            if (u.status === 'skipped') u.status = 'waiting';
                        });

                        this.broadcast({
                            type: 'startRound',
                            state: 'round-' + Date.now(),
                            seed: Math.random()
                        })

                        // Force finish after 5 minutes
                        if (this.forceFinishTimer) clearTimeout(this.forceFinishTimer);
                        this.forceFinishTimer = setTimeout(() => {
                            if (this.status === 'playing') {
                                console.log('[Room] Match timeout. Force finishing.');
                                this.finishMatch();
                            }
                        }, 300000);
                    } else if (this.status === 'selecting') {
                        if (this.forceFinishTimer) clearTimeout(this.forceFinishTimer);
                        this.forceFinishTimer = null;
                    }
                } else {
                    console.warn(`[Room] updateStatus ignored: Requestor ${userId} is not master ${this.master}`);
                }
                break
            case 'updateLevel':
                if (this.lead === userId && this.status === 'selecting') {
                    this.level = command.level
                    this.levelOptions = []
                    this.broadcast({ type: 'updateLevel', level: this.level })
                }
                break
            case 'addSuggestion':
                if (!this.isSuggestionsLocked) {
                    this.suggestions.push({ userId, level: command.level })
                    this.broadcast({ type: 'updateSuggestions', suggestions: this.suggestions })
                }
                break
            case 'clearSuggestions':
                if (this.lead === userId || this.master === userId) {
                    this.suggestions = []
                    this.broadcast({ type: 'clearSuggestions' })
                }
                break
            case 'updateAutoExit':
                if (this.lead === userId || this.master === userId) {
                    this.autoExit = command.autoExit
                    this.broadcast({ type: 'updateAutoExit', autoExit: this.autoExit })
                }
                break
            case 'updateMaster':
                if (this.master === userId) {
                    this.master = command.master
                    this.broadcast({ type: 'updateMaster', master: this.master })
                }
                break
            case 'updateLead':
                if (this.master === userId) {
                    this.lead = command.lead
                    this.broadcast({ type: 'updateLead', lead: this.lead })
                }
                break
            case 'resetScoreboard':
                if (this.master === userId) {
                    this.scoreboardSections = [{
                        title: '#SCOREBOARD',
                        icon: 'crown',
                        scores: []
                    }]
                    this.broadcast({
                        type: 'updateScoreboardSections',
                        scoreboardSections: this.scoreboardSections
                    })
                }
                break;
            case 'startGameplay':
                console.log(`[Room] startGameplay from ${userId}`);
                this.updateUserStatus(userId, 'playing');
                break;
            case 'finishGameplay':
                console.log(`[Room] finishGameplay from ${userId}`);
                // Record results
                if (command.result) {
                    const user = this.users.find(u => u.profile.id === userId);
                    const userName = user ? user.profile.name : "Unknown";

                    this.results.push({ userId, result: command.result, userName })
                    this.broadcast({ type: 'addResult', result: { userId, result: command.result, userName } })

                    // Check if all playing users have finished
                    const activePlayers = this.users.filter(u => u.status === 'playing' && !this.results.find(r => r.userId === u.profile.id))
                    if (activePlayers.length === 0) {
                        console.log('[Room] All players finished. Finishing match.');
                        this.finishMatch();
                    } else {
                        // For the user who just finished, send a full UpdateEvent
                        const user = this.users.find(u => u.profile.id === userId);
                        if (user) {
                            console.log(`[Room] Individual finished gameplay, sending UpdateEvent to ${user.profile.name}`);
                            this.sendUpdate(user.ws, userId);
                        }
                    }
                }
                break
        }
    }

    private finishMatch() {
        if (this.forceFinishTimer) clearTimeout(this.forceFinishTimer);
        this.forceFinishTimer = null;

        // Record to leaderboard
        const resolvedTitle = typeof this.title === 'string' ? this.title : (this.title.en || this.title.ru || 'Room');
        resultsStore.addMatch(resolvedTitle, this.level, this.results);

        this.updateScoreboard();
        this.status = 'selecting';
        this.users.forEach(u => u.status = 'waiting');

        // Broadcast a full update to everyone
        this.broadcastUpdate();
    }

    private updateScoreboard() {
        this.scoreboardSections = [{
            title: '#SCOREBOARD',
            icon: 'crown',
            scores: this.results
                .sort((a, b) => b.result.arcadeScore - a.result.arcadeScore)
                .map(r => ({
                    userId: r.userId,
                    value: r.result.arcadeScore.toString()
                }))
        }];
        console.log('[Room] Scoreboard updated:', JSON.stringify(this.scoreboardSections));
    }

    private updateUserStatus(userId: ServiceUserId, status: UserStatus) {
        const user = this.users.find(u => u.profile.id === userId)
        if (user) user.status = status

        this.broadcast({
            type: 'updateUserStatus',
            userStatus: { userId, status }
        })
    }

    private sendUpdate(ws: WebSocket, userId: ServiceUserId, newUserEntry?: any) {
        const allUsers = newUserEntry ? [...this.users, newUserEntry] : this.users

        const users = allUsers.map(u => ({
            authentication: u.user.authentication,
            signature: u.user.signature
        }))

        const userStatuses = allUsers.map(u => ({
            userId: u.profile.id,
            status: u.status
        }))

        // Resolve title to string (Sonolus protocol requirement for UpdateEvent)
        const resolvedTitle = typeof this.title === 'string' ? this.title : (this.title.en || this.title.ru || 'Room')

        const updateEvent = {
            type: 'update' as const,
            allowOtherServers: this.allowOtherServers,
            reportUserOptions: [
                {
                    type: 'inappropriate_name',
                    title: '#REPORT_REASON_INAPPROPRIATE_NAME',
                    requireConfirmation: true,
                    options: []
                },
                {
                    type: 'cheating',
                    title: '#REPORT_REASON_CHEATING',
                    requireConfirmation: true,
                    options: []
                }
            ],
            title: resolvedTitle,
            status: this.status,
            master: this.master,
            lead: this.lead,
            options: this.options,
            optionValues: this.optionValues || 'type=basic',
            level: this.level,
            levelOptions: this.levelOptions.map((o, i) => ({ index: i, value: o.value })),
            autoExit: this.autoExit,
            isSuggestionsLocked: this.isSuggestionsLocked,
            suggestions: this.suggestions,
            scoreboardDescription: this.scoreboardDescription,
            scoreboardSections: this.scoreboardSections.length > 0 ? this.scoreboardSections : [
                {
                    title: '#SCOREBOARD',
                    icon: '',
                    scores: []
                }
            ],
            results: this.results,
            users: users,
            userStatuses: userStatuses
        }
        ws.send(JSON.stringify(updateEvent))
    }

    private broadcastUpdate() {
        console.log(`[Room] Broadcasting full UpdateEvent to ${this.users.length} users`);
        this.users.forEach(u => {
            if (u.ws.readyState === WebSocket.OPEN) {
                this.sendUpdate(u.ws, u.profile.id);
            }
        });
    }

    private broadcast(event: any, excludeUserId?: ServiceUserId) {
        const message = JSON.stringify(event)
        console.log(`[Room] Broadcasting: ${event.type} to ${this.users.length} users`);
        this.users.forEach(u => {
            if (u.profile.id === excludeUserId) return
            if (u.ws.readyState === WebSocket.OPEN) {
                u.ws.send(message)
            }
        })
    }
}
