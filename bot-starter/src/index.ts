// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { chooseWord, decideBid } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "spacetimedb",
  "wordlist.txt",
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const matchStateSubscriptions = new Map<bigint, { unsubscribe(): void }>();
const matchDataSubscriptions = new Map<bigint, { unsubscribe(): void }>();
const pendingMatchStateChecks = new Set<bigint>();
const runningMatchIds = new Set<bigint>();
const WORD_RETRY_MS = 500;
let credentialClaimRequested = false;
let botSubscriptionsStarted = false;

function opponentPaymentHistoryFor(
  conn: DbConnection,
  matchId: bigint,
  letter: string,
  myScore: number,
): { score: number; winningPayments: number[] }[] {
  const letterKey = letter.toUpperCase();
  const results = [...conn.db.auctionResult.resultByMatch.filter(matchId)];
  const opponents: { score: number; winningPayments: number[] }[] = [];
  for (const participant of conn.db.matchParticipant.iter()) {
    if (participant.matchId !== matchId || participant.botId === myBotId) {
      continue;
    }
    const score = Number(participant.score);
    if (score * 10 < myScore * 9) continue;
    opponents.push({
      score,
      winningPayments: results
        .filter(
          (result) =>
            result.letter.toUpperCase() === letterKey &&
            result.winnerBotId === participant.botId,
        )
        .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
        .slice(-8)
        .map((result) => Number(result.paid)),
    });
  }
  return opponents;
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function reportSubscriptionError(conn: DbConnection, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${BOT_NAME}] subscription failed: ${message}`);
}

function maybeJoinLobby(conn: DbConnection) {
  if (pendingMatchStateChecks.size > 0 || runningMatchIds.size > 0) return;
  joinLobby(conn);
}

function stopTrackingMatch(matchId: bigint) {
  pendingMatchStateChecks.delete(matchId);
  runningMatchIds.delete(matchId);
  matchStateSubscriptions.get(matchId)?.unsubscribe();
  matchDataSubscriptions.get(matchId)?.unsubscribe();
  matchStateSubscriptions.delete(matchId);
  matchDataSubscriptions.delete(matchId);
}

function subscribeToMatchData(conn: DbConnection, matchId: bigint) {
  if (matchDataSubscriptions.has(matchId)) return;
  const handle = conn
    .subscriptionBuilder()
    .onError((ctx) => reportSubscriptionError(conn, ctx.event))
    .onApplied(() => {
      for (const auction of conn.db.auction.iter()) {
        if (auction.matchId === matchId && auction.status.tag === "Open") {
          tryBid(conn, auction.id, matchId, auction.letter);
        }
      }
      tryPlayWord(conn);
    })
    .subscribe((tables) => [
      tables.auction.where((auction) => auction.matchId.eq(matchId)),
      tables.auctionResult.where((result) => result.matchId.eq(matchId)),
      tables.myRack.where((holding) => holding.matchId.eq(matchId)),
    ]);
  matchDataSubscriptions.set(matchId, handle);
}

function trackMatch(conn: DbConnection, matchId: bigint) {
  if (matchStateSubscriptions.has(matchId)) return;
  pendingMatchStateChecks.add(matchId);
  const handle = conn
    .subscriptionBuilder()
    .onError((ctx) => {
      pendingMatchStateChecks.delete(matchId);
      reportSubscriptionError(conn, ctx.event);
      maybeJoinLobby(conn);
    })
    .onApplied(() => {
      pendingMatchStateChecks.delete(matchId);
      const state = conn.db.matchState.id.find(matchId);
      if (state?.status.tag === "Running") {
        runningMatchIds.add(matchId);
        subscribeToMatchData(conn, matchId);
      } else {
        stopTrackingMatch(matchId);
        maybeJoinLobby(conn);
      }
    })
    .subscribe((tables) =>
      tables.matchState.where((state) => state.id.eq(matchId)),
    );
  matchStateSubscriptions.set(matchId, handle);
}

function startBotSubscriptions(conn: DbConnection, botId: bigint) {
  if (botSubscriptionsStarted) return;
  botSubscriptionsStarted = true;
  conn
    .subscriptionBuilder()
    .onError((ctx) => reportSubscriptionError(conn, ctx.event))
    .onApplied(() => {
      const bot = conn.db.bot.id.find(botId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${botId})`,
      );
      for (const participant of conn.db.matchParticipant.iter()) {
        if (participant.botId === botId) trackMatch(conn, participant.matchId);
      }
      if (TOURNAMENT_ID) {
        conn.reducers
          .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
          .then(() =>
            console.log(
              `[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`,
            ),
          )
          .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
      }
      maybeJoinLobby(conn);
    })
    .subscribe((tables) => [
      tables.bot.where((bot) => bot.id.eq(botId)),
      tables.matchParticipant.where((participant) =>
        participant.botId.eq(botId),
      ),
    ]);
}

function activateBot(conn: DbConnection) {
  myBotId = resolveMyBotId(conn);
  if (myBotId !== null) {
    startBotSubscriptions(conn, myBotId);
    return;
  }
  if (!BOT_NONCE) {
    console.error(
      `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
    );
    return;
  }
  if (credentialClaimRequested) return;
  credentialClaimRequested = true;
  console.log(`[${BOT_NAME}] claiming credential with nonce…`);
  conn.reducers
    .claimCredential({ code: BOT_NONCE })
    .catch(logFailure("claiming the credential"));
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const match = conn.db.matchState.id.find(matchId);
  const auction = conn.db.auction.id.find(auctionId);
  if (
    !match ||
    match.status.tag !== "Running" ||
    match.currentAuctionId !== auctionId ||
    !auction ||
    auction.matchId !== matchId ||
    auction.status.tag !== "Open"
  ) {
    return;
  }
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myScore: participant.score,
    myRack: rackForMatch(conn, matchId),
    dictionary: DICTIONARY,
    isVickrey: match.auctionType.tag === "Vickrey",
    opponents: opponentPaymentHistoryFor(
      conn,
      matchId,
      letter,
      participant.score,
    ),
  });
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!/auction closed/i.test(message)) {
        logFailure(`bid on auction ${auctionId}`)(err);
      }
    });
  bidsByAuction.add(key);
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId})`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  const now = Date.now();
  for (const matchId of runningMatchIds) {
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const matchState = conn.db.matchState.id.find(matchId);
    const participant = participantForMatch(conn, matchId);
    if (!matchState || !participant) continue;
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
      myBalance: participant.balance,
      bagRemaining: matchState.bagTotal,
    });
    if (!word) continue;
    console.log(`[${BOT_NAME}] match ${matchId}: playing '${word}'`);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn.db.auction.onInsert((_ctx: EventContext, auction) => {
    if (auction.status.tag === "Open") {
      tryBid(conn, auction.id, auction.matchId, auction.letter);
    }
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.botCredential.onInsert(() => activateBot(conn));
  conn.db.matchParticipant.onInsert((_ctx, participant) => {
    if (participant.botId === myBotId) trackMatch(conn, participant.matchId);
  });
  conn.db.auctionResult.onInsert((_ctx, result) => {
    if (myBotId === null) return;
    const winner =
      result.winnerBotId !== undefined && result.winnerBotId !== null
        ? String(result.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${result.matchId} auction ${result.auctionId} '${result.letter}' → bot ${winner} paid ${result.paid}`,
    );
  });
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (
      neu.status.tag === "Running" &&
      neu.currentAuctionId !== undefined &&
      neu.currentAuctionId !== old.currentAuctionId
    ) {
      const auction = conn.db.auction.id.find(neu.currentAuctionId);
      if (auction) tryBid(conn, auction.id, neu.id, auction.letter);
    }
    if (
      old.status.tag !== "Ended" &&
      neu.status.tag === "Ended" &&
      runningMatchIds.has(neu.id)
    ) {
      console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
      stopTrackingMatch(neu.id);
      maybeJoinLobby(conn);
    }
  });

  conn
    .subscriptionBuilder()
    .onError((ctx) => reportSubscriptionError(conn, ctx.event))
    .onApplied(() => {
      activateBot(conn);
    })
    .subscribe((tables) => [
      tables.botCredential.where((credential) =>
        credential.identity.eq(identity),
      ),
      tables.openLobbies,
      tables.openLobbyMembers,
    ]);
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const openLobby = Array.from(conn.db.openLobbies.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.openLobbyMembers.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
