import json
from sentence_transformers import SentenceTransformer
from qdrant_client import QdrantClient, models
from fastapi import FastAPI

client = QdrantClient(":memory:")
collection_name = "test"
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
app = FastAPI()

food_vectors = {}

def load_food():

    path = "data/foods.json"

    with open(path, "r", encoding="utf-8") as file:
        foods = json.load(file)

        return foods


def searchable():

    list_foods = load_food()
    new_food_list = []

    for food in list_foods:

        searchable_text = " ".join([
            food["name"],
            food["category"],
            food["cuisine"],
            food["description"],
            " ".join(food["flavors"]),
            " ".join(food["tags"]),
            food["emoji"],
        ])

        new_food_list.append({
            "id": food["id"],
            "name": food["name"],
            "category": food["category"],
            "cuisine": food["cuisine"],
            "description": food["description"],
            "flavors": food["flavors"],
            "tags": food["tags"],
            "emoji": food["emoji"],
            "text": searchable_text
        })

    return new_food_list


def encode_vector():

    foods = searchable()
    first_food = foods[0]
    text = first_food["text"]

    encoder = model.encode(text)

    return encoder


def collection():

    if client.collection_exists(collection_name=collection_name):
        client.delete_collection(collection_name=collection_name)

    client.create_collection(
        collection_name=collection_name,
        vectors_config=models.VectorParams(
            size=384,
            distance=models.Distance.COSINE
        )
    )

    print("Collection has been made")


def upload_points():

    points = []
    list_foods = searchable()

    for food in list_foods:
        vector = model.encode(food["text"]).tolist()

        food_vectors[food["id"]] = vector

        points.append(
            models.PointStruct(
                id=food["id"],
                vector=vector,
                payload=food
            )
        )

    client.upsert(
        collection_name=collection_name,
        points=points
    )

    print(f"Uploaded {len(points)} food points")


def test_search():

    query = "spicy noodles"

    query_vector = model.encode(query).tolist()

    results = client.query_points(
        collection_name=collection_name,
        query=query_vector,
        limit=3
    )

    for point in results.points:
        print(point.payload["name"])
        print(point.score)
        print("---")

@app.on_event("startup")
def startup():
    collection()
    upload_points()


@app.get("/")
def home():
    return {
        "message": "Food backend is running"
    }


@app.get("/foods")
def get_foods():
    foods = load_food()

    return {
        "meta": {
            "count": len(foods),
            "dataset_size": len(foods)
        },
        "results": foods
    }