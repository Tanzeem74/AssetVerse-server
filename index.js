const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
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
        const requestsCollection = db.collection("requests");
        const employeeAffiliationsCollection = db.collection("employeeAffiliations");
        const paymentCollection = db.collection('payments');



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

                const assets = await assetsCollection.find(query).sort(sortOptions).skip(skip).limit(limit).toArray();
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

        app.get("/all-requests", verifyFBToken, verifyHR, async (req, res) => {
            const hrEmail = req.hr_data.hrEmail;
            const search = req.query.search || "";
            const query = { hrEmail: hrEmail };
            if (search) {
                query.$or = [
                    { requesterName: { $regex: search, $options: 'i' } },
                    { requesterEmail: { $regex: search, $options: 'i' } }
                ];
            }
            const requests = await requestsCollection.find(query).toArray();
            res.send(requests);
        });

        app.patch("/requests/approve/:id", verifyFBToken, verifyHR, async (req, res) => {
            const id = req.params.id;
            const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
            const hrEmail = req.hr_data.hrEmail;

            if (!request) return res.status(404).send({ message: "Request not found" });
            const hr = await usersCollection.findOne({ email: hrEmail });
            if (hr.currentEmployees >= hr.packageLimit) {
                return res.status(400).send({ message: "Package limit reached! Please upgrade." });
            }
            await requestsCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { requestStatus: "approved", approvalDate: new Date() } }
            );
            await assetsCollection.updateOne(
                { _id: new ObjectId(request.assetId) },
                { $inc: { availableQuantity: -1 } }
            );
            const isAffiliated = await employeeAffiliationsCollection.findOne({
                employeeEmail: request.requesterEmail,
                hrEmail: hrEmail
            });
            if (!isAffiliated) {
                await employeeAffiliationsCollection.insertOne({
                    employeeEmail: request.requesterEmail,
                    employeeName: request.requesterName,
                    hrEmail: hrEmail,
                    companyName: hr.companyName,
                    companyLogo: hr.companyLogo,
                    affiliationDate: new Date(),
                    status: "active"
                });
                await usersCollection.updateOne(
                    { email: hrEmail },
                    { $inc: { currentEmployees: 1 } }
                );
            }
            res.send({ success: true, message: "Approved and Affiliated" });
        });
        
        app.patch("/requests/reject/:id", verifyFBToken, verifyHR, async (req, res) => {
            try {
                const id = req.params.id;
                const result = await requestsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { requestStatus: "rejected" } }
                );
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Reject failed" });
            }
        });

        app.get("/my-employees", verifyFBToken, verifyHR, async (req, res) => {
            const hrEmail = req.hr_data.hrEmail;
            const employees = await employeeAffiliationsCollection.find({
                hrEmail: hrEmail, status: "active"
            }).toArray();
            const hr = await usersCollection.findOne({ email: hrEmail });
            res.send({
                employees,
                currentEmployees: hr.currentEmployees || 0,
                packageLimit: hr.packageLimit || 5
            });
        });
        //remobe
        app.patch("/remove-employee/:email", verifyFBToken, verifyHR, async (req, res) => {
            const employeeEmail = req.params.email;
            const hrEmail = req.hr_data.hrEmail;
            await employeeAffiliationsCollection.deleteOne({ employeeEmail, hrEmail });
            await usersCollection.updateOne(
                { email: hrEmail },
                { $inc: { currentEmployees: -1 } }
            );
            res.send({ success: true, message: "Employee removed from team" });
        });

        app.get("/hr-stats", verifyFBToken, verifyHR, async (req, res) => {
            const hrEmail = req.hr_data.hrEmail;
            const assets = await assetsCollection.find({ hrEmail: hrEmail }).toArray();
            const returnableCount = assets.filter(a => a.productType === "Returnable").length;
            const nonReturnableCount = assets.filter(a => a.productType === "Non-returnable").length;
            const pendingRequests = await requestsCollection.find({
                hrEmail: hrEmail,
                requestStatus: "pending"
            }).limit(5).toArray();
            const totalRequests = await requestsCollection.countDocuments({ hrEmail: hrEmail });
            res.send({
                pieData: [
                    { name: 'Returnable', value: returnableCount },
                    { name: 'Non-returnable', value: nonReturnableCount }
                ],
                pendingRequests,
                totalRequests
            });
        });

        //available emplys
        app.get("/available-employees", verifyFBToken, verifyHR, async (req, res) => {
            const affiliated = await employeeAffiliationsCollection.find({}, { projection: { employeeEmail: 1 } }).toArray();
            const affiliatedEmails = affiliated.map(a => a.employeeEmail);
            const query = {
                role: "employee",
                email: { $nin: affiliatedEmails }
            };
            const result = await usersCollection.find(query).toArray();
            res.send(result);
        });

        app.get("/hr-package-status", verifyFBToken, async (req, res) => {
            const email = req.decoded_email;
            const hr = await usersCollection.findOne({ email });
            if (!hr) {
                return res.status(404).send({ message: "HR not found" });
            }
            res.send({
                currentEmployees: hr.currentEmployees || 0,
                packageLimit: hr.packageLimit || 5
            });
        });

        //adding to team
        app.post("/add-to-team", verifyFBToken, verifyHR, async (req, res) => {
            try {
                const { employeeEmail, employeeName } = req.body;
                const hrEmail = req.hr_data.hrEmail;
                const hr = await usersCollection.findOne({ email: hrEmail });
                const currentCount = hr.currentEmployees || 0;
                const limit = hr.packageLimit || 5;
                if (currentCount >= limit) {
                    return res.status(400).send({ message: "Limit reached! Upgrade your package." });
                }
                const affiliationData = {
                    employeeEmail,
                    employeeName,
                    hrEmail,
                    companyName: hr.companyName || "Your Company",
                    companyLogo: hr.companyLogo || hr.image || "",
                    affiliationDate: new Date(),
                    status: "active"
                };
                await employeeAffiliationsCollection.insertOne(affiliationData);
                await usersCollection.updateOne(
                    { email: hrEmail },
                    { $inc: { currentEmployees: 1 } }
                );
                res.send({ success: true });
            } catch (error) {
                res.status(500).send({ message: "Internal Server Error" });
            }
        });



        //employee
        app.get("/available-assets", verifyFBToken, async (req, res) => {
            const assets = await assetsCollection.find({
                availableQuantity: { $gt: 0 }
            }).toArray();
            res.send(assets);
        });
        app.post("/asset-requests", verifyFBToken, async (req, res) => {
            const request = req.body;
            request.requesterEmail = req.decoded_email;
            request.requestStatus = "pending";
            request.requestDate = new Date();

            const result = await requestsCollection.insertOne(request);
            res.send(result);
        });
        app.get("/my-requests", verifyFBToken, async (req, res) => {
            const email = req.decoded_email;
            const search = req.query.search || "";
            const status = req.query.status || "";

            const query = { requesterEmail: email };
            if (search) {
                query.assetName = { $regex: search, $options: 'i' };
            }
            if (status) {
                query.requestStatus = status;
            }

            const result = await requestsCollection.find(query).toArray();
            res.send(result);
        });
        app.delete("/requests/cancel/:id", verifyFBToken, async (req, res) => {
            const id = req.params.id;
            const result = await requestsCollection.deleteOne({
                _id: new ObjectId(id),
                requestStatus: "pending"
            });
            res.send(result);
        });

        app.patch("/requests/return/:id", verifyFBToken, async (req, res) => {
            const id = req.params.id;
            const request = await requestsCollection.findOne({ _id: new ObjectId(id) });
            await requestsCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { requestStatus: "returned" } }
            );
            await assetsCollection.updateOne(
                { _id: new ObjectId(request.assetId) },
                { $inc: { availableQuantity: 1 } }
            );

            res.send({ success: true });
        });
        app.get("/employee-stats", verifyFBToken, async (req, res) => {
            const email = req.decoded_email;
            const pendingRequests = await requestsCollection.find({
                requesterEmail: email,
                requestStatus: "pending"
            }).toArray();
            const currentMonth = new Date().getMonth();
            const currentYear = new Date().getFullYear();

            const allRequests = await requestsCollection.find({ requesterEmail: email }).toArray();
            const monthlyRequests = allRequests.filter(req => {
                const date = new Date(req.requestDate);
                return date.getMonth() === currentMonth && date.getFullYear() === currentYear;
            });
            const affiliation = await employeeAffiliationsCollection.findOne({ employeeEmail: email });
            res.send({
                pendingRequests,
                monthlyRequests,
                affiliation
            });
        });

        // 1. Create Checkout Session
        app.post('/payment-checkout-session', verifyFBToken, verifyHR, async (req, res) => {
            const { price, members } = req.body;
            const email = req.decoded_email;

            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{
                        price_data: {
                            currency: 'usd',
                            product_data: {
                                name: `Upgrade: ${members} Slots`,
                                description: 'Increase your employee limit'
                            },
                            unit_amount: parseInt(price) * 100,
                        },
                        quantity: 1,
                    }],
                    mode: 'payment',
                    metadata: {
                        hrEmail: email,
                        newLimit: String(members) // Metadata string hotei hobe
                    },
                    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/upgrade`,
                });
                res.send({ url: session.url });
            } catch (error) {
                res.status(500).send({ message: error.message });
            }
        });

        // 2. Verify and Update Limit
        app.patch('/payment-success', verifyFBToken, async (req, res) => {
            const sessionId = req.query.session_id;

            if (!sessionId) {
                return res.status(400).send({ success: false, message: "Session ID missing" });
            }

            try {
                const session = await stripe.checkout.sessions.retrieve(sessionId);

                if (session.payment_status !== 'paid') {
                    return res.status(400).send({ success: false, message: "Payment not completed" });
                }

                const transactionId = session.payment_intent;
                const hrEmail = session.metadata.hrEmail;
                const addedSlots = parseInt(session.metadata.newLimit) || 0;

                if (addedSlots <= 0) {
                    return res.status(400).send({ success: false, message: "Invalid slot count" });
                }

                // 🔁 Duplicate check
                const alreadyDone = await paymentCollection.findOne({ transactionId });
                if (alreadyDone) {
                    return res.send({ success: true, message: "Already processed" });
                }

                // 🔥 GET CURRENT HR
                const hr = await usersCollection.findOne({ email: hrEmail });
                if (!hr) {
                    return res.status(404).send({ success: false, message: "HR not found" });
                }

                const currentLimit = hr.packageLimit || 5;
                const newLimit = currentLimit + addedSlots;

                // 🔥 SAFE UPDATE
                await usersCollection.updateOne(
                    { email: hrEmail },
                    {
                        $set: {
                            packageLimit: newLimit,
                            lastUpgrade: new Date()
                        }
                    }
                );

                // Payment record
                await paymentCollection.insertOne({
                    hrEmail,
                    transactionId,
                    amount: session.amount_total / 100,
                    addedSlots,
                    date: new Date()
                });

                res.send({
                    success: true,
                    message: "Limit upgraded successfully",
                    newLimit
                });

            } catch (error) {
                console.error("Payment Error:", error);
                res.status(500).send({ success: false, message: "Internal Server Error" });
            }
        });

        app.get('/payment-history', verifyFBToken, verifyHR, async (req, res) => {
            const hrEmail = req.decoded_email; // middleware theke pawa email
            const result = await paymentCollection.find({ hrEmail }).sort({ date: -1 }).toArray();
            res.send(result);
        });

        app.get('/my-team', verifyFBToken, async (req, res) => {
            try {
                const email = req.decoded_email;

                // Logged-in user
                const user = await usersCollection.findOne({ email });
                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                // HR email determine
                let hrEmail;
                if (user.role === 'hr') {
                    hrEmail = user.email;
                } else {
                    // employee হলে affiliation থেকে HR বের করবো
                    const affiliation = await employeeAffiliationsCollection.findOne({
                        employeeEmail: email,
                        status: "active"
                    });

                    if (!affiliation) {
                        return res.send([]); // team নাই
                    }

                    hrEmail = affiliation.hrEmail;
                }

                // 🔥 HR info
                const hr = await usersCollection.findOne({ email: hrEmail, role: 'hr' });

                // 🔥 Employee affiliations
                const affiliations = await employeeAffiliationsCollection.find({
                    hrEmail,
                    status: "active"
                }).toArray();

                // 🔥 Employee user details join করা
                const employeeEmails = affiliations.map(a => a.employeeEmail);

                const employees = await usersCollection.find({
                    email: { $in: employeeEmails }
                }).toArray();

                // 🔥 Final team array
                const team = [
                    hr,
                    ...employees
                ];

                res.send(team);

            } catch (error) {
                console.error("My Team Error:", error);
                res.status(500).send({ message: "Internal Server Error" });
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