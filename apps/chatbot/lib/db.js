import { MongoClient, ServerApiVersion } from 'mongodb';

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot_service';

let client = null;
let isConnected = false;

export async function connectChatbotDb() {
	if (client && isConnected) return client.db();

	try {
		client = new MongoClient(uri, {
			serverApi: {
				version: ServerApiVersion.v1,
				strict: true,
				deprecationErrors: true,
			},
			maxPoolSize: 10,
			connectTimeoutMS: 5000,
		});

		await client.connect();
		isConnected = true;
		return client.db();
	} catch {
		return null;
	}
}
