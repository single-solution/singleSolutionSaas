import { MongoClient, ServerApiVersion } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/analytics_engine';

let client;
let clientPromise;

if (process.env.NODE_ENV === 'development') {
	if (!global._mongoAnalyticsPromise) {
		client = new MongoClient(uri, {
			serverApi: {
				version: ServerApiVersion.v1,
				strict: false,
				deprecationErrors: true,
			},
			maxPoolSize: 10,
			connectTimeoutMS: 5000,
			serverSelectionTimeoutMS: 5000,
		});
		global._mongoAnalyticsPromise = client.connect();
	}
	clientPromise = global._mongoAnalyticsPromise;
} else {
	client = new MongoClient(uri, {
		serverApi: {
			version: ServerApiVersion.v1,
			strict: false,
			deprecationErrors: true,
		},
		maxPoolSize: 10,
		connectTimeoutMS: 5000,
		serverSelectionTimeoutMS: 5000,
	});
	clientPromise = client.connect();
}

export async function connectAnalyticsDb() {
	try {
		const connectedClient = await clientPromise;
		return connectedClient.db();
	} catch (err) {
		console.warn('Analytics DB Connection Note:', err.message);
		return null;
	}
}
