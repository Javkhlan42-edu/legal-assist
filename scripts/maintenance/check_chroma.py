#!/usr/bin/env python3
"""Check ChromaDB collection contents and query results."""

import chromadb
import numpy as np
from sentence_transformers import SentenceTransformer

# Connect to ChromaDB
client = chromadb.HttpClient(host="localhost", port=8000)

# List all collections
print("📚 Collections in ChromaDB:")
collections = client.list_collections()
for col in collections:
    print(f"  - {col.name}: {col.count()} documents")

# Get the mn_legal_rag collection
collection_name = "mn_legal_rag"
try:
    collection = client.get_collection(name=collection_name, include=["embeddings", "documents", "metadatas"])
    print(f"\n✅ Found collection: {collection_name}")
    print(f"   Document count: {collection.count()}")
    
    # Get a sample document
    if collection.count() > 0:
        print("\n📄 Sample documents:")
        results = collection.get(limit=3)
        for i, (id_, doc, meta) in enumerate(zip(results["ids"], results["documents"], results["metadatas"])):
            print(f"  [{i+1}] ID: {id_[:20]}...")
            print(f"      Text: {doc[:100]}...")
            print(f"      Meta: {meta}")
    
    # Test a query
    print("\n🔍 Testing a query...")
    test_query = "Хөдөлмөрийн гэрээг цуцлах журам юу вэ?"
    
    # Load the embedding model (same as API)
    print("   Loading embedding model...")
    model = SentenceTransformer('Xenova/all-MiniLM-L6-v2')
    query_embedding = model.encode(test_query).tolist()
    
    # Query the collection
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=10,
        include=["documents", "metadatas", "distances"]
    )
    
    print(f"   Query: {test_query}")
    print(f"   Found {len(results['ids'][0])} results:")
    for i, (id_, doc, meta, distance) in enumerate(zip(
        results["ids"][0], 
        results["documents"][0], 
        results["metadatas"][0],
        results["distances"][0]
    )):
        # ChromaDB returns distances, need to convert to similarity scores
        # For cosine distance: similarity = 1 - distance
        similarity = 1 - distance
        print(f"     [{i+1}] Similarity: {similarity:.4f} (distance: {distance:.4f})")
        print(f"         ID: {id_[:20]}...")
        print(f"         Text: {doc[:80]}...")
        
except Exception as e:
    print(f"❌ Error accessing collection {collection_name}: {e}")

print("\n✅ Check complete!")
