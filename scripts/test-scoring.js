/* Offline tests for scoring + GraphQL extraction + breakdown */
const s = require("../extension/lib/scoring.js");

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const spam = s.scoreFollower({
  screenName: "user12345678",
  followersCount: 0,
  followingCount: 900,
  statusesCount: 0,
  defaultProfileImage: true,
  description: "DM for promo free airdrop t.me/scam",
  source: "graphql",
});
console.log("spam-like", spam.riskScore, spam.category, spam.flags);

assert(spam.riskScore >= 70, "expected high risk for spam-like account");
assert(
  Array.isArray(spam.contributions) && spam.contributions.length > 0,
  "contributions missing",
);
assert(
  spam.contributions.every((c) => typeof c.points === "number"),
  "points must be numbers",
);
const sum = spam.contributions.reduce((a, c) => a + c.points, 0);
assert(
  spam.riskScore === Math.max(0, Math.min(100, Math.round(sum))),
  `risk should equal clamped sum (${spam.riskScore} vs ${sum})`,
);
assert(
  spam.explanation && spam.explanation.includes("Risk"),
  "explanation missing",
);

const good = s.scoreFollower({
  screenName: "example_user",
  name: "Example User",
  followersCount: 5000,
  followingCount: 400,
  statusesCount: 1200,
  isBlueVerified: true,
  createdAt: "2015-01-01",
  description: "Building useful open source projects",
  profileImageUrl: "https://pbs.twimg.com/profile_images/x_bigger.jpg",
  listedCount: 12,
  following: true,
  followedBy: true,
  source: "graphql",
});
console.log("established", good.riskScore, good.flags);

assert(
  good.riskScore < spam.riskScore,
  "established should score better than spam",
);
assert(good.riskScore <= 40, "established account should be low/medium risk");
assert(
  good.flags.includes("verified") ||
    good.contributions.some((c) => c.id === "verified"),
  "verified offset expected",
);

const domOnly = s.scoreFollower({
  screenName: "Someone",
  name: "Someone",
  description: "FE developer",
  source: "dom",
  defaultProfileImage: false,
  profileImageUrl: "https://pbs.twimg.com/x.jpg",
});
console.log("dom-only", domOnly.riskScore, domOnly.flags);
assert(
  domOnly.riskScore < 40,
  "dom-only without bad signals should not be critical",
);
assert(
  !domOnly.flags.includes("no_posts"),
  "dom-only must not treat missing counts as zero posts",
);

const payload = {
  data: {
    user: {
      result: {
        timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    content: {
                      itemContent: {
                        user_results: {
                          result: {
                            __typename: "User",
                            rest_id: "1",
                            core: { screen_name: "a", name: "A" },
                            legacy: {
                              followers_count: 1,
                              friends_count: 500,
                              statuses_count: 0,
                              description: "",
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
};

const users = s.extractUsersFromGraphQL(payload);
console.log(
  "extract",
  users.length,
  users[0] && users[0].screenName,
  users[0] && users[0].riskScore,
  users[0] && users[0].contributions && users[0].contributions.length,
);
assert(users.length === 1, "GraphQL extract empty");
assert(
  users[0].contributions && users[0].contributions.length,
  "normalized user needs contributions",
);

const docs = s.getScoreDocs();
assert(docs.groups && docs.groups.length >= 5, "score docs incomplete");
assert(docs.bands.CRITICAL, "bands missing");
assert(s.flagLabel("no_posts") === "No posts", "flag labels broken");

console.log("OK");
