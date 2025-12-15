const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const { MongoClient, ServerApiVersion } = require('mongodb');
const port = 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./firebase-service.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


app.use(cors());
app.use(express.json());

//middleares
const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log('decoded in the token', decoded);
        req.decoded_email = decoded.email;
        next();
    }
    catch (err) {
        return res.status(401).send({ message: 'unauthorized access' })
    }


}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ox4mfpm.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db("assetverseDB");
        const usersCollection = db.collection("users");
        const assetsCollection = db.collection("assets");



        const verifyHR = async (req, res, next) => {
            const email = req.decoded_email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            if (!user || user.role !== 'hr') {
                return res.status(403).send({ message: 'Forbidden access. Only HR Managers allowed.' });
            }
            req.hr_data = {
                hrEmail: user.email,
                companyName: user.companyName,
                packageLimit: user.packageLimit || 5,
            };

            next();
        }


        //users related api
        //inserting new user
        app.post("/users", async (req, res) => {
            const newUser = req.body;

            const existing = await usersCollection.findOne({ email: newUser.email });
            if (existing) {
                return res.send({ message: "User already exists", inserted: false });
            }

            const result = await usersCollection.insertOne(newUser);
            res.send(result);
        });
        app.get('/users/:email/role', verifyFBToken, async (req, res) => {
            const email = req.params.email;
            const query = { email }
            const user = await usersCollection.findOne(query);
            res.send({ role: user?.role })
        })
        //packages
        app.get("/packages", async (req, res) => {
            try {
                const packages = await client.db("assetverseDB").collection("packages").find().toArray();
                res.send(packages);
            } catch (error) {
                res.status(500).send({ message: "Failed to load packages", error });
            }
        });

        //HR related
        app.post("/assets", verifyFBToken, verifyHR, async (req, res) => {
            try {
                const newAsset = req.body;
                const hrDetails = req.hr_data;
                const { productName, productImage, productType, productQuantity } = newAsset;

                if (!productName || !productQuantity || !productType) {
                    return res.status(400).send({ message: 'Missing required fields: name, quantity, or type.' });
                }
                const assetDoc = {
                    productName,
                    productImage,
                    productType,
                    productQuantity: parseInt(productQuantity),
                    availableQuantity: parseInt(productQuantity),
                    dateAdded: new Date(),
                    hrEmail: hrDetails.hrEmail,
                    companyName: hrDetails.companyName,
                };

                const result = await assetsCollection.insertOne(assetDoc);
                return res.status(201).send(result);

            } catch (error) {
                console.error("Error adding asset:", error);
                res.status(500).send({ message: "Failed to add asset." });
            }
        });

        app.get("/assets", verifyFBToken, verifyHR, async (req, res) => {
            try {
                const hrDetails = req.hr_data;
                const page = parseInt(req.query.page) || 1;
                const limit = parseInt(req.query.limit) || 10;
                const search = req.query.search || "";
                const skip = (page - 1) * limit;
                const sortBy = req.query.sort || 'dateAdded';
                const order = req.query.order === 'asc' ? 1 : -1;
                const typeFilter = req.query.type || "";
                const query = {
                    hrEmail: hrDetails.hrEmail,
                };
                if (search) {
                    query.productName = { $regex: search, $options: 'i' };
                }
                if (typeFilter) {
                    query.productType = typeFilter;
                }
                const sortOptions = {};
                sortOptions[sortBy] = order;

                const assets = await assetsCollection
                    .find(query)
                    .sort(sortOptions)
                    .skip(skip)
                    .limit(limit)
                    .toArray();
                const totalAssets = await assetsCollection.countDocuments(query);
                const totalPages = Math.ceil(totalAssets / limit);

                res.send({
                    assets,
                    totalAssets,
                    totalPages,
                    currentPage: page
                });

            } catch (error) {
                console.error("Error fetching assets:", error);
                res.status(500).send({ message: "Failed to fetch assets." });
            }
        });





        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        //await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('hello');
})

app.listen(port, () => {
    console.log(`listen on port ${port}`);
})