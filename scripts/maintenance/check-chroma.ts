import { ChromaClient } from 'chromadb';

async function checkChroma() {
  try {
    const client = new ChromaClient({ host: 'localhost', port: 8000 });
    const collections = await client.listCollections();
    console.log('Collections:', collections);

    if (collections.length > 0) {
      const collection = collections[0];
      console.log(`\nCollection: ${collection.name}`);
      const count = await collection.count();
      console.log(`Total embeddings: ${count}`);

      // Get a sample
      const sample = await collection.get({ limit: 5 });
      console.log(`\nSample embeddings:`);
      console.log(JSON.stringify(sample, null, 2));
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

checkChroma();
