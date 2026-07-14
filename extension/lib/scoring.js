/**
 * Quality / spam scoring for X followers.
 *
 * riskScore 0–100  = higher means more likely spam / low-value / dead account
 * qualityScore     = 100 - riskScore
 *
 * Each rule emits a contribution { id, label, points, detail? }.
 * Final risk = clamp(sum(points), 0, 100).
 */
(function (root) {
  /** Human labels for flags / rule ids */
  const FLAG_META = {
    very_new: {
      label: "Very new account",
      detail: "Created less than 7 days ago",
    },
    new_account: {
      label: "New account",
      detail: "Created less than 30 days ago",
    },
    young_account: {
      label: "Young account",
      detail: "Created less than 90 days ago",
    },
    established: {
      label: "Established account",
      detail: "3+ years old with real post history",
    },
    unknown_age: {
      label: "Unknown age",
      detail: "Account creation date not available",
    },
    default_avatar: {
      label: "Default avatar",
      detail: "Still using the stock profile image",
    },
    default_profile: {
      label: "Default profile theme",
      detail: "Profile still looks unfinished",
    },
    empty_bio: {
      label: "Empty bio",
      detail: "No profile description",
    },
    thin_bio: {
      label: "Very short bio",
      detail: "Bio shorter than 12 characters",
    },
    no_posts: {
      label: "No posts",
      detail: "0 tweets/posts published",
    },
    almost_no_posts: {
      label: "Almost no posts",
      detail: "Fewer than 5 posts",
    },
    low_posts: {
      label: "Low post count",
      detail: "Fewer than 20 posts",
    },
    ghost_old: {
      label: "Ghost / abandoned",
      detail: "Older account with almost no content",
    },
    follow_farm: {
      label: "Follow farm pattern",
      detail: "Follows hundreds while barely posting",
    },
    zero_followers: {
      label: "Zero followers",
      detail: "Follows many people but has 0 followers",
    },
    extreme_following_ratio: {
      label: "Extreme following ratio",
      detail: "Following ≫ followers (botty mass-follow)",
    },
    high_following_ratio: {
      label: "High following ratio",
      detail: "Following much higher than followers",
    },
    elevated_following_ratio: {
      label: "Elevated following ratio",
      detail: "Following/followers imbalance",
    },
    mass_following: {
      label: "Mass following",
      detail: "Following thousands of accounts",
    },
    low_social_proof: {
      label: "Low social proof",
      detail: "Almost no followers while following many",
    },
    spam_bio: {
      label: "Spam-like bio",
      detail: "Bio matches promo / scam / adult spam patterns",
    },
    suspicious_handle: {
      label: "Suspicious handle",
      detail: "Handle looks auto-generated (user+digits, etc.)",
    },
    spam_name: {
      label: "Spam-like display name",
      detail: "Name contains giveaway / NSFW / promo keywords",
    },
    emoji_spam_name: {
      label: "Emoji-spam name",
      detail: "Display name flooded with promotional emoji",
    },
    link_farm_bio: {
      label: "Link-heavy bio",
      detail: "Multiple external links in a short bio",
    },
    protected: {
      label: "Protected account",
      detail: "Private account (slight risk reduction)",
    },
    verified: {
      label: "Verified / Premium",
      detail: "Blue check or verified badge",
    },
    incomplete_shell: {
      label: "Empty shell profile",
      detail: "No bio, no location, default avatar",
    },
    like_farm: {
      label: "Like-farm pattern",
      detail: "Huge likes, almost no own posts/media",
    },
    listed: {
      label: "Listed by others",
      detail: "Appears on several public lists",
    },
    mutual: {
      label: "Mutual follow",
      detail: "You follow each other",
    },
    follows_you: {
      label: "Follows you",
      detail: "They follow you (not mutual)",
    },
    healthy_ratio: {
      label: "Healthy audience ratio",
      detail: "Followers ≥ following on an active account",
    },
    active_poster: {
      label: "Active poster",
      detail: "Substantial own content",
    },
    partial_data: {
      label: "Partial data",
      detail: "Scored from visible UI only (counts incomplete)",
    },
    banned_words: {
      label: "Banned keyword(s)",
      detail: "Name, handle or bio contains forbidden terms",
    },
  };

  const SUSPICIOUS_BIO = [
    {
      re: /onlyfans|o\.?f\.?\s*link|privacy\.com\.br|fansly/i,
      tag: "adult_promo",
    },
    { re: /linktr\.ee\/|allmylinks\.com\/|beacons\.ai\//i, tag: "link_hub" },
    {
      re: /crypto\s*(?:airdrop|giveaway|free\s*money)|free\s*nft/i,
      tag: "crypto_spam",
    },
    {
      re: /dm\s*(?:for|me)\s*(?:promo|collab|promotion|business|rates)/i,
      tag: "promo_dm",
    },
    { re: /\bf4f\b|follow\s*back|followback|folow\s*back/i, tag: "followback" },
    { re: /whatsapp\s*\+?\d|telegram\s*:?\s*@|t\.me\//i, tag: "offplatform" },
    {
      re: /(?:make|earn)\s*\$?\d+[kK]?\s*(?:\/|per)\s*(?:day|week|month)/i,
      tag: "get_rich",
    },
    { re: /casino|betting|forex\s*signal|binary\s*option/i, tag: "gambling" },
    {
      re: /nude|escort|cam\s*girl|sex\s*chat|hot\s*girl\s*near/i,
      tag: "adult_spam",
    },
    {
      re: /subscribe\s*(?:to)?\s*my|click\s*(?:the\s*)?link\s*in\s*bio/i,
      tag: "sub_spam",
    },
  ];

  const SUSPICIOUS_HANDLE = [
    /^[a-z]+\d{6,}$/i,
    /^user\d+$/i,
    /^(?:bot|spam|promo)\w*/i,
    /_{3,}|\d{8,}/,
    /^[a-z]{1,3}\d{4,}_?[a-z0-9]*$/i,
    /^[a-z0-9]{12,}$/i, // long random alphanumeric
    /\d{4,}[a-z]{1,3}\d{3,}/i,
  ];

  // Forbidden terms in name, handle or bio. Extend this list as needed.
  const BANNED_WORDS = [
    "porn", "porno", "pornography",
    "xxx",
    "sex", "sext", "sexchat", "sex chat",
    "nude", "nudes", "naked",
    "sexy",
    "escort", "escorts", "prostitute", "hooker",
    "camgirl", "cam girl", "camgirls",
    "onlyfans", "fansly",
    "nsfw", "adult content", "adult",
    "hot girl", "hot girls",
    "fetish",
    "call girl", "call girls",
    "sugar baby", "sugardaddy", "sugar daddy", "sugar mommy",
    "buy nudes", "nude pics", "private snap",
  ];

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&");
  }

  function countBannedWords(text) {
    const t = (text || "").toLowerCase();
    let matches = 0;
    for (const word of BANNED_WORDS) {
      const re = new RegExp("\\b" + escapeRegExp(word) + "\\b", "i");
      if (re.test(t)) matches++;
    }
    return matches;
  }

  const SCORE_RULES_DOC = [
    {
      group: "Account age",
      rules: [
        { flag: "very_new", points: "+22", when: "< 7 days old" },
        { flag: "new_account", points: "+14", when: "< 30 days old" },
        { flag: "young_account", points: "+6", when: "< 90 days old" },
        { flag: "established", points: "−8", when: "≥ 3 years + ≥ 50 posts" },
        {
          flag: "unknown_age",
          points: "+3",
          when: "creation date missing (API data only)",
        },
      ],
    },
    {
      group: "Profile completeness",
      rules: [
        {
          flag: "default_avatar",
          points: "+16",
          when: "default / missing avatar",
        },
        {
          flag: "default_profile",
          points: "+5",
          when: "default profile chrome",
        },
        { flag: "empty_bio", points: "+12", when: "no bio" },
        { flag: "thin_bio", points: "+5", when: "bio < 12 chars" },
        {
          flag: "incomplete_shell",
          points: "+6",
          when: "no bio + no location + default avatar",
        },
      ],
    },
    {
      group: "Activity",
      rules: [
        { flag: "no_posts", points: "+22", when: "0 posts" },
        { flag: "almost_no_posts", points: "+14", when: "1–4 posts" },
        { flag: "low_posts", points: "+6", when: "5–19 posts" },
        {
          flag: "ghost_old",
          points: "+10",
          when: "≥ 180 days old and < 5 posts",
        },
        { flag: "active_poster", points: "−6", when: "≥ 200 posts" },
        {
          flag: "follow_farm",
          points: "+18",
          when: "following > 500 and posts < 10",
        },
        {
          flag: "like_farm",
          points: "+8",
          when: "likes > 10k, media 0, posts < 50",
        },
      ],
    },
    {
      group: "Network ratios",
      rules: [
        {
          flag: "zero_followers",
          points: "+16",
          when: "0 followers and following > 100",
        },
        {
          flag: "extreme_following_ratio",
          points: "+14",
          when: "following/followers > 50",
        },
        { flag: "high_following_ratio", points: "+9", when: "ratio > 20" },
        { flag: "elevated_following_ratio", points: "+4", when: "ratio > 10" },
        {
          flag: "mass_following",
          points: "+8 to +14",
          when: "following > 2k / > 5k",
        },
        {
          flag: "low_social_proof",
          points: "+10",
          when: "followers < 5 and following > 50",
        },
        {
          flag: "healthy_ratio",
          points: "−5",
          when: "followers ≥ following and posts ≥ 50",
        },
      ],
    },
    {
      group: "Spam signals",
      rules: [
        {
          flag: "spam_bio",
          points: "+10 to +20",
          when: "bio matches promo/scam/adult patterns",
        },
        { flag: "link_farm_bio", points: "+6", when: "many URLs in short bio" },
        {
          flag: "suspicious_handle",
          points: "+12",
          when: "auto-generated looking @handle",
        },
        {
          flag: "spam_name",
          points: "+14",
          when: "giveaway / NSFW keywords in name",
        },
        {
          flag: "emoji_spam_name",
          points: "+8",
          when: "promotional emoji spam in name",
        },
        {
          flag: "banned_words",
          points: "+15 to +40",
          when: "name, handle or bio contains forbidden terms",
        },
      ],
    },
    {
      group: "Trust offsets",
      rules: [
        { flag: "verified", points: "−16", when: "verified / Premium badge" },
        { flag: "mutual", points: "−10", when: "you follow each other" },
        { flag: "follows_you", points: "−2", when: "they follow you" },
        { flag: "listed", points: "−5", when: "on > 5 public lists" },
        { flag: "protected", points: "−2", when: "protected account" },
      ],
    },
    {
      group: "Data quality",
      rules: [
        {
          flag: "partial_data",
          points: "0 (neutral)",
          when: "DOM-only scan: missing counts, so ratio/post rules are skipped",
        },
      ],
    },
  ];

  const BANDS = {
    LOW: {
      min: 0,
      max: 34,
      label: "Low risk",
      color: "#00ba7c",
      meaning: "Looks like a normal account",
    },
    MEDIUM: {
      min: 35,
      max: 54,
      label: "Medium",
      color: "#ffd400",
      meaning: "Some weak signals — review",
    },
    HIGH: {
      min: 55,
      max: 74,
      label: "High risk",
      color: "#ff7a00",
      meaning: "Strong spam / inactive signals",
    },
    CRITICAL: {
      min: 75,
      max: 100,
      label: "Critical",
      color: "#f4212e",
      meaning: "Very likely bot / spam / shell",
    },
  };

  function daysSince(isoOrMs) {
    if (!isoOrMs) return null;
    const t = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function countUrls(text) {
    if (!text) return 0;
    const m = text.match(/https?:\/\/|www\.|\.com\/|\.io\/|t\.co\//gi);
    return m ? m.length : 0;
  }

  function countPromoEmoji(text) {
    if (!text) return 0;
    const m = text.match(
      /[\u{1F4B0}\u{1F680}\u{1F525}\u{1F4B8}\u{1F4B5}\u{1F48E}\u{1F911}\u{1F4A5}]/gu,
    );
    return m ? m.length : 0;
  }

  /**
   * @returns {{
   *   riskScore: number,
   *   qualityScore: number,
   *   flags: string[],
   *   category: string,
   *   contributions: Array<{id:string,label:string,points:number,detail?:string}>,
   *   explanation: string
   * }}
   */
  function scoreFollower(u, opts = {}) {
    const contributions = [];

    function add(id, points, detailOverride) {
      if (!points) return;
      const meta = FLAG_META[id] || { label: id, detail: "" };
      contributions.push({
        id,
        label: meta.label,
        points,
        detail: detailOverride || meta.detail || "",
      });
    }

    // DOM-only rows often lack counts — don't treat missing metrics as zeros.
    const hasCounts = u.source !== "dom" || u.countsKnown === true;
    if (!hasCounts) {
      // informative only (0 points) — still listed in breakdown
      contributions.push({
        id: "partial_data",
        label: FLAG_META.partial_data.label,
        points: 0,
        detail: FLAG_META.partial_data.detail,
      });
    }

    const followers = hasCounts ? (u.followersCount ?? 0) : null;
    const following = hasCounts ? (u.followingCount ?? 0) : null;
    const statuses = hasCounts ? (u.statusesCount ?? 0) : null;
    const likes = hasCounts ? (u.favouritesCount ?? 0) : null;
    const listed = hasCounts ? (u.listedCount ?? 0) : null;
    const media = hasCounts ? (u.mediaCount ?? 0) : null;
    const ageDays = daysSince(u.createdAt);
    const bio = (u.description || "").trim();
    const handle = (u.screenName || "").toLowerCase();
    const name = u.name || "";
    const defaultAvatar =
      !u.profileImageUrl ||
      /default_profile/i.test(u.profileImageUrl || "") ||
      u.defaultProfileImage === true;
    const defaultBanner = u.defaultProfile === true;

    // --- Account age ---
    if (ageDays != null) {
      if (ageDays < 7) {
        add("very_new", 22, `Age: ${ageDays} day(s)`);
      } else if (ageDays < 30) {
        add("new_account", 14, `Age: ${ageDays} day(s)`);
      } else if (ageDays < 90) {
        add("young_account", 6, `Age: ${ageDays} day(s)`);
      } else if (ageDays >= 365 * 3 && statuses != null && statuses >= 50) {
        add(
          "established",
          -8,
          `Age: ${Math.floor(ageDays / 365)}y · ${statuses} posts`,
        );
      }
    } else if (hasCounts) {
      add("unknown_age", 3);
    }

    // --- Profile completeness ---
    if (defaultAvatar) add("default_avatar", 16);
    if (defaultBanner) add("default_profile", 5);
    if (!bio) add("empty_bio", 12);
    else if (bio.length < 12) add("thin_bio", 5, `Bio length: ${bio.length}`);

    if (!bio && !u.location && defaultAvatar) {
      add("incomplete_shell", 6);
    }

    // --- Activity ---
    if (statuses != null) {
      if (statuses === 0) add("no_posts", 22);
      else if (statuses < 5) add("almost_no_posts", 14, `${statuses} posts`);
      else if (statuses < 20) add("low_posts", 6, `${statuses} posts`);
      else if (statuses >= 200) add("active_poster", -6, `${statuses} posts`);

      if (ageDays != null && ageDays >= 180 && statuses < 5) {
        add("ghost_old", 10, `${ageDays}d old · ${statuses} posts`);
      }
    }

    if (
      following != null &&
      statuses != null &&
      following > 500 &&
      statuses < 10
    ) {
      add("follow_farm", 18, `Following ${following} · posts ${statuses}`);
    }

    // --- Ratios ---
    let followRatio = null; // following / followers
    let followerRatio = null; // followers / following
    if (followers != null && following != null) {
      followRatio =
        followers > 0 ? following / Math.max(followers, 1) : following;
      followerRatio = following > 0 ? followers / following : followers;
      const ratioTxt =
        followers > 0 ? `ratio ${followRatio.toFixed(1)}` : "no followers";

      if (followers === 0 && following > 100) {
        add("zero_followers", 16, `Following ${following}`);
      } else if (followRatio > (opts.maxFollowingRatio || 50)) {
        add("extreme_following_ratio", 14, ratioTxt);
      } else if (followRatio > 20) {
        add("high_following_ratio", 9, ratioTxt);
      } else if (followRatio > 10) {
        add("elevated_following_ratio", 4, ratioTxt);
      }

      if (following > 5000) {
        add("mass_following", 14, `Following ${following}`);
      } else if (following > 2000) {
        add("mass_following", 8, `Following ${following}`);
      }

      if (followers < 5 && following > 50) {
        add(
          "low_social_proof",
          10,
          `${followers} followers · ${following} following`,
        );
      }

      if (
        followers >= following &&
        statuses != null &&
        statuses >= 50 &&
        followers >= 50
      ) {
        add("healthy_ratio", -5, ratioTxt);
      }
    }

    // --- Spam text ---
    let bioSpamHits = 0;
    for (const { re } of SUSPICIOUS_BIO) {
      if (re.test(bio)) bioSpamHits++;
    }
    if (bioSpamHits > 0) {
      const pts = Math.min(20, 10 + bioSpamHits * 4);
      add("spam_bio", pts, `${bioSpamHits} pattern(s) matched`);
    }

    const urls = countUrls(bio);
    if (urls >= 2 && bio.length < 160) {
      add("link_farm_bio", 6, `${urls} link-like tokens`);
    }

    for (const re of SUSPICIOUS_HANDLE) {
      if (re.test(handle)) {
        add("suspicious_handle", 12, `@${handle}`);
        break;
      }
    }

    if (
      /FREE|GIVEAWAY|AIRDROP|SIGNAL|NSFW|ONLYFANS|CRYPTO\s*GEMS/i.test(name)
    ) {
      add("spam_name", 14);
    }
    const emojiN = countPromoEmoji(name);
    if (emojiN >= 3) {
      add("emoji_spam_name", 8, `${emojiN} promo emoji`);
    }

    // --- Banned / forbidden keywords (name, handle, bio) ---
    const combinedText = `${name} ${handle} ${bio}`;
    const bannedWordHits = countBannedWords(combinedText);
    if (bannedWordHits > 0) {
      const pts = Math.min(40, 15 + bannedWordHits * 5);
      add("banned_words", pts, `${bannedWordHits} forbidden term(s)`);
    }

    // --- Soft signals ---
    if (u.protected) add("protected", -2);

    if (u.verified || u.isBlueVerified) {
      add("verified", -16);
    }

    if (
      media != null &&
      likes != null &&
      statuses != null &&
      media === 0 &&
      likes > 10000 &&
      statuses < 50
    ) {
      add("like_farm", 8, `${likes} likes · ${statuses} posts`);
    }

    if (listed != null && listed > 5) {
      add("listed", -5, `On ${listed} lists`);
    }

    if (u.followedBy && u.following) {
      add("mutual", -10);
    } else if (u.followedBy && !u.following) {
      add("follows_you", -2);
    }

    const risk = clamp(
      Math.round(contributions.reduce((s, c) => s + c.points, 0)),
      0,
      100,
    );
    const qualityScore = 100 - risk;
    const flags = [
      ...new Set(contributions.filter((c) => c.points !== 0).map((c) => c.id)),
    ];

    let category = "ok";
    if (risk >= 75) category = "critical";
    else if (risk >= 55) category = "high_risk";
    else if (risk >= 35) category = "medium";
    else if (flags.includes("no_posts") || flags.includes("almost_no_posts"))
      category = "inactive";
    else category = "ok";

    if (
      statuses != null &&
      statuses === 0 &&
      (ageDays == null || ageDays > 30) &&
      category === "ok"
    ) {
      category = "inactive";
    }

    // Sort contributions: risk drivers first, then offsets
    contributions.sort((a, b) => b.points - a.points);

    const top = contributions
      .filter((c) => c.points > 0)
      .slice(0, 3)
      .map((c) => c.label);
    const offsets = contributions
      .filter((c) => c.points < 0)
      .slice(0, 2)
      .map((c) => c.label);

    let explanation = `Risk ${risk}/100`;
    if (top.length) explanation += ` · driven by: ${top.join(", ")}`;
    if (offsets.length) explanation += ` · reduced by: ${offsets.join(", ")}`;
    if (!hasCounts) explanation += " · (partial data)";

    return {
      riskScore: risk,
      qualityScore,
      flags,
      category,
      contributions,
      explanation,
      followRatio,
      followerRatio,
    };
  }

  function riskBand(score) {
    const R = (root.XFC && root.XFC.RISK) || {
      LOW: { min: 0, max: 34, label: "Low", color: "#00ba7c" },
      MEDIUM: { min: 35, max: 54, label: "Medium", color: "#ffd400" },
      HIGH: { min: 55, max: 74, label: "High", color: "#ff7a00" },
      CRITICAL: { min: 75, max: 100, label: "Critical", color: "#f4212e" },
    };
    // Prefer extended BANDS when available for richer copy
    for (const key of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
      const b = BANDS[key] || R[key];
      if (score >= b.min && score <= b.max) {
        return {
          key,
          min: b.min,
          max: b.max,
          label: b.label,
          color: b.color,
          meaning: b.meaning || "",
        };
      }
    }
    return { key: "LOW", ...BANDS.LOW };
  }

  function flagLabel(id) {
    return (FLAG_META[id] && FLAG_META[id].label) || id;
  }

  function flagDetail(id) {
    return (FLAG_META[id] && FLAG_META[id].detail) || "";
  }

  function getScoreDocs() {
    return {
      summary:
        "Each follower starts at 0 risk. Rules add or subtract points. Final risk is clamped to 0–100. Quality = 100 − risk.",
      bands: BANDS,
      groups: SCORE_RULES_DOC,
      flags: FLAG_META,
    };
  }

  /**
   * Normalize GraphQL user result → our schema
   */
  function normalizeUser(raw, perspective) {
    if (!raw) return null;
    const legacy = raw.legacy || {};
    const core = raw.core || {};
    const avatar = raw.avatar || {};
    const locationObj = raw.location || {};
    const professional = raw.professional || {};

    const screenName =
      core.screen_name || legacy.screen_name || raw.screen_name || "";
    const restId = String(
      raw.rest_id || raw.id_str || legacy.id_str || raw.id || "",
    );

    if (!screenName && !restId) return null;

    const profileImage =
      avatar.image_url ||
      legacy.profile_image_url_https ||
      legacy.profile_image_url ||
      raw.profile_image_url_https ||
      "";

    const createdAt =
      core.created_at || legacy.created_at || raw.created_at || null;

    const rel = perspective || raw.relationship_perspectives || {};
    const following = rel.following === true || legacy.following === true;
    const followedBy =
      rel.followed_by === true ||
      legacy.followed_by === true ||
      raw.followed_by === true;

    const u = {
      id: restId,
      screenName,
      name: core.name || legacy.name || raw.name || screenName,
      description: legacy.description || raw.description || "",
      location: locationObj.location || legacy.location || "",
      profileImageUrl: profileImage.replace("_normal.", "_bigger."),
      followersCount: legacy.followers_count ?? raw.followers_count ?? 0,
      followingCount:
        legacy.friends_count ??
        legacy.following_count ??
        raw.friends_count ??
        0,
      statusesCount: legacy.statuses_count ?? raw.statuses_count ?? 0,
      favouritesCount: legacy.favourites_count ?? raw.favourites_count ?? 0,
      listedCount: legacy.listed_count ?? 0,
      mediaCount: legacy.media_count ?? raw.media_count ?? 0,
      createdAt,
      verified: !!(legacy.verified || raw.is_blue_verified || raw.verified),
      isBlueVerified: !!(raw.is_blue_verified || raw.isBlueVerified),
      protected: !!(legacy.protected || raw.protected),
      defaultProfile: !!legacy.default_profile,
      defaultProfileImage: !!legacy.default_profile_image,
      following,
      followedBy,
      professionalType: professional.professional_type || null,
      capturedAt: Date.now(),
      source: "graphql",
    };

    const scored = scoreFollower(u);
    return { ...u, ...scored };
  }

  /**
   * Walk GraphQL JSON for user results in Followers timelines
   */
  function extractUsersFromGraphQL(payload) {
    const found = [];
    const seen = new Set();

    function visit(node, depth) {
      if (!node || depth > 40) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (typeof node !== "object") return;

      if (
        node.__typename === "User" ||
        (node.rest_id && (node.legacy || node.core))
      ) {
        const n = normalizeUser(node);
        if (n && n.id && !seen.has(n.id)) {
          seen.add(n.id);
          found.push(n);
        }
      }

      if (node.user_results?.result) {
        const n = normalizeUser(node.user_results.result);
        if (n && n.id && !seen.has(n.id)) {
          seen.add(n.id);
          found.push(n);
        }
      }
      if (
        node.result?.__typename === "User" ||
        node.result?.legacy ||
        node.result?.core
      ) {
        const n = normalizeUser(node.result);
        if (n && n.id && !seen.has(n.id)) {
          seen.add(n.id);
          found.push(n);
        }
      }

      for (const k of Object.keys(node)) {
        if (k === "rawQuery") continue;
        visit(node[k], depth + 1);
      }
    }

    visit(payload, 0);
    return found;
  }

  function filterFollowers(list, filters) {
    const f = filters || {};
    return list.filter((u) => {
      if (f.query) {
        const q = f.query.toLowerCase();
        const blob = `${u.name} ${u.screenName} ${u.description}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (f.minRisk != null && u.riskScore < f.minRisk) return false;
      if (f.maxRisk != null && u.riskScore > f.maxRisk) return false;
      if (f.category && f.category !== "all" && u.category !== f.category)
        return false;
      if (
        f.onlyDefaultAvatar &&
        !u.defaultProfileImage &&
        u.profileImageUrl &&
        !/default_profile/i.test(u.profileImageUrl)
      ) {
        return false;
      }
      if (f.onlyNoPosts && (u.statusesCount || 0) > 0) return false;
      if (f.onlyUnverified && (u.verified || u.isBlueVerified)) return false;
      if (f.onlyMassFollowing && (u.followingCount || 0) <= 2000) return false;
      if (f.flag && !(u.flags || []).includes(f.flag)) return false;
      if (f.minFollowers != null && (u.followersCount || 0) < f.minFollowers)
        return false;
      if (f.maxFollowers != null && (u.followersCount || 0) > f.maxFollowers)
        return false;
      if (
        f.minFollowRatio != null &&
        (u.followRatio ?? 0) < f.minFollowRatio
      )
        return false;
      if (
        f.maxFollowRatio != null &&
        (u.followRatio ?? 0) > f.maxFollowRatio
      )
        return false;
      return true;
    });
  }

  function summarize(list) {
    const s = {
      total: list.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      noPosts: 0,
      defaultAvatar: 0,
      verified: 0,
      avgRisk: 0,
    };
    let riskSum = 0;
    for (const u of list) {
      riskSum += u.riskScore || 0;
      if (u.riskScore >= 75) s.critical++;
      else if (u.riskScore >= 55) s.high++;
      else if (u.riskScore >= 35) s.medium++;
      else s.low++;
      if ((u.statusesCount || 0) === 0 && u.source !== "dom") s.noPosts++;
      else if ((u.flags || []).includes("no_posts")) s.noPosts++;
      if (
        u.defaultProfileImage ||
        /default_profile/i.test(u.profileImageUrl || "")
      )
        s.defaultAvatar++;
      if (u.verified || u.isBlueVerified) s.verified++;
    }
    s.avgRisk = list.length ? Math.round(riskSum / list.length) : 0;
    return s;
  }

  const api = {
    scoreFollower,
    riskBand,
    normalizeUser,
    extractUsersFromGraphQL,
    filterFollowers,
    summarize,
    daysSince,
    flagLabel,
    flagDetail,
    getScoreDocs,
    FLAG_META,
    BANDS,
  };

  root.XFCScoring = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
