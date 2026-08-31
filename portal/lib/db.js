import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/portal_core';

let client;
let clientPromise;

if (process.env.NODE_ENV === 'development') {
	if (!global._mongoClientPromise) {
		client = new MongoClient(uri, {
			maxPoolSize: 10,
			serverSelectionTimeoutMS: 3000,
		});
		global._mongoClientPromise = client.connect();
	}
	clientPromise = global._mongoClientPromise;
} else {
	client = new MongoClient(uri, {
		maxPoolSize: 10,
		serverSelectionTimeoutMS: 5000,
	});
	clientPromise = client.connect();
}

export async function connectPortalDb() {
	try {
		const connectedClient = await clientPromise;
		return connectedClient.db();
	} catch (err) {
		console.error('[MongoDB Error] Unable to connect to database:', err.message);
		return null;
	}
}
