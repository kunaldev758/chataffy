const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config();

const APPLY = process.argv.includes("--apply");
const CLEAN_DUPLICATES = process.argv.includes("--cleanup-duplicates");
const INDEX_NAME = "uniq_url_owner_agent";
const INDEX_KEY = { userId: 1, agentId: 1, url: 1 };

function hasExactKey(index, expectedKey) {
  const actualEntries = Object.entries(index.key || {});
  const expectedEntries = Object.entries(expectedKey);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([key, direction], indexPosition) =>
        actualEntries[indexPosition]?.[0] === key &&
        actualEntries[indexPosition]?.[1] === direction,
    )
  );
}

function duplicatePreference(document) {
  const statusRank = {
    processed: 6,
    fetched: 5,
    queued: 4,
    discovered: 3,
    skipped: 2,
    failed: 1,
  };
  const trainedScore = document.trainStatus === 1 ? 100 : 0;
  const contentScore = document.contentHash ? 20 : 0;
  const statusScore = statusRank[document.status] || 0;
  const updatedScore = new Date(document.updatedAt || 0).getTime() / 1e13;
  return trainedScore + contentScore + statusScore + updatedScore;
}

async function inspectDuplicates(collection) {
  return collection
    .aggregate(
      [
        {
          $group: {
            _id: {
              userId: "$userId",
              agentId: "$agentId",
              url: "$url",
            },
            ids: { $push: "$_id" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ],
      { allowDiskUse: true },
    )
    .toArray();
}

async function cleanExactDuplicates(collection, duplicateGroups) {
  let deletedCount = 0;

  for (const group of duplicateGroups) {
    const documents = await collection
      .find({ _id: { $in: group.ids } })
      .toArray();
    documents.sort(
      (left, right) =>
        duplicatePreference(right) - duplicatePreference(left),
    );

    const duplicateIds = documents.slice(1).map((document) => document._id);
    if (!duplicateIds.length) continue;

    const result = await collection.deleteMany({
      _id: { $in: duplicateIds },
    });
    deletedCount += result.deletedCount;
    console.info("[url-index-migration:duplicates-cleaned]", {
      userId: String(group._id.userId),
      agentId: String(group._id.agentId),
      url: group._id.url,
      keptId: String(documents[0]._id),
      deletedCount: result.deletedCount,
    });
  }

  return deletedCount;
}

async function migrate() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const collection = mongoose.connection.collection("urls");
  const indexes = await collection.indexes();
  const missingOwnershipCount = await collection.countDocuments({
    $or: [
      { userId: { $exists: false } },
      { userId: null },
      { agentId: { $exists: false } },
      { agentId: null },
      { url: { $exists: false } },
      { url: null },
    ],
  });
  const duplicateGroups = await inspectDuplicates(collection);
  const globalUniqueIndexes = indexes.filter(
    (index) => index.unique && hasExactKey(index, { url: 1 }),
  );
  const ownershipIndexes = indexes.filter((index) =>
    hasExactKey(index, INDEX_KEY),
  );
  const conflictingNamedIndex = indexes.find(
    (index) => index.name === INDEX_NAME && !hasExactKey(index, INDEX_KEY),
  );

  console.info("[url-index-migration:inspection]", {
    mode: APPLY ? "apply" : "dry-run",
    missingOwnershipCount,
    duplicateGroupCount: duplicateGroups.length,
    duplicateSamples: duplicateGroups.slice(0, 20).map((group) => ({
      userId: String(group._id.userId),
      agentId: String(group._id.agentId),
      url: group._id.url,
      count: group.count,
    })),
    globalUniqueIndexes: globalUniqueIndexes.map((index) => index.name),
    ownershipIndexes: ownershipIndexes.map((index) => ({
      name: index.name,
      unique: !!index.unique,
    })),
    conflictingNamedIndex: conflictingNamedIndex?.name || null,
  });

  if (!APPLY) {
    console.info(
      "Dry run only. Re-run with --apply after reviewing the inspection.",
    );
    return;
  }

  if (missingOwnershipCount > 0) {
    throw new Error(
      `Refusing migration: ${missingOwnershipCount} Url records are missing userId, agentId, or url`,
    );
  }

  if (conflictingNamedIndex) {
    throw new Error(
      `Refusing migration: index name ${INDEX_NAME} already exists with a different key`,
    );
  }

  if (duplicateGroups.length > 0 && !CLEAN_DUPLICATES) {
    throw new Error(
      `Refusing migration: ${duplicateGroups.length} exact owner/agent/url duplicate groups exist. Review them, then re-run with --apply --cleanup-duplicates`,
    );
  }

  if (duplicateGroups.length > 0) {
    const deletedCount = await cleanExactDuplicates(
      collection,
      duplicateGroups,
    );
    console.info("[url-index-migration:cleanup-summary]", { deletedCount });
  }

  for (const index of ownershipIndexes) {
    if (!index.unique) {
      await collection.dropIndex(index.name);
      console.info("[url-index-migration:index-dropped]", {
        name: index.name,
        reason: "non_unique_owner_index",
      });
    }
  }

  const uniqueOwnershipIndex = ownershipIndexes.find(
    (index) => index.unique,
  );
  if (uniqueOwnershipIndex) {
    console.info("[url-index-migration:index-exists]", {
      name: uniqueOwnershipIndex.name,
      key: INDEX_KEY,
    });
  } else {
    await collection.createIndex(INDEX_KEY, {
      name: INDEX_NAME,
      unique: true,
    });
    console.info("[url-index-migration:index-created]", {
      name: INDEX_NAME,
      key: INDEX_KEY,
    });
  }

  for (const index of globalUniqueIndexes) {
    await collection.dropIndex(index.name);
    console.info("[url-index-migration:index-dropped]", {
      name: index.name,
      reason: "global_url_uniqueness",
    });
  }
}

migrate()
  .catch((error) => {
    console.error("[url-index-migration:failed]", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
