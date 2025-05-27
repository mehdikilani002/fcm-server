require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const fs = require('fs');

// Initialiser Firebase Admin avec le fichier de clé JSON fourni via Render
let serviceAccount = null;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    serviceAccount = JSON.parse(
      fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')
    );

/*try {
    serviceAccount = JSON.parse(
      fs.readFileSync('/etc/secrets/serviceAccountKey.json', 'utf8')
    );
    */
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log(' Firebase Admin initialisé avec succès.');
  } catch (err) {
    console.error(' Erreur de lecture de la clé :', err.message);
    process.exit(1);
  }
} else {
  console.error(' GOOGLE_APPLICATION_CREDENTIALS n’est pas défini.');
  process.exit(1);
}

const app = express();
app.use(express.json());

//  Endpoint pour envoyer une notification FCM
app.post('/send', async (req, res) => {
  const { token, title, body } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ error: 'Champs requis : token, title, body' });
  }

  const message = {
    token,
    notification: {
      title,
      body
    }
  };

  try {
    const response = await admin.messaging().send(message);
    res.status(200).json({ message: 'Notification envoyée', id: response });
  } catch (error) {
    console.error('Erreur envoi FCM:', error);
    res.status(500).json({ error: 'Échec de l’envoi FCM' });
  }
});

//  Endpoint pour envoyer un message et sauvegarder dans Firestore
app.post('/send-message', async (req, res) => {
  const { senderId, receiverId, text } = req.body;

  if (!senderId || !receiverId || !text) {
    return res.status(400).json({ error: 'Champs requis : senderId, receiverId, text' });
  }

  const firestore = admin.firestore();
  const usersRef = firestore.collection('users');

  try {
    const [senderSnap, receiverSnap] = await Promise.all([
      usersRef.doc(senderId).get(),
      usersRef.doc(receiverId).get()
    ]);

    const senderName = senderSnap.data()?.name || 'Inconnu';
    const receiverName = receiverSnap.data()?.name || 'Inconnu';

    const conversationId = senderId < receiverId
      ? `${senderId}-${receiverId}`
      : `${receiverId}-${senderId}`;

    const messageData = {
      senderId,
      receiverId,
      text,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    await firestore
      .collection('chats')
      .doc(conversationId)
      .collection('messages')
      .add(messageData);

    const convoForSender = {
      userName: receiverName,
      lastMessage: text,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      senderId,
      receiverId
    };

    const convoForReceiver = {
      userName: senderName,
      lastMessage: text,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      senderId,
      receiverId
    };

    await Promise.all([
      firestore.collection('userConversations').doc(senderId).collection('conversations').doc(receiverId).set(convoForSender),
      firestore.collection('userConversations').doc(receiverId).collection('conversations').doc(senderId).set(convoForReceiver)
    ]);

    const fcmTokens = receiverSnap.data()?.fcmToken;
    let notificationResult = null;

    if (Array.isArray(fcmTokens) && fcmTokens.length > 0) {
      const messages = fcmTokens.map(token => ({
        token,
        notification: {
          title: senderName,
          body: text
        },
        data: {
          conversationId,
          senderName,
          text,
          senderId,
        }
      }));

      console.log('→ Tokens FCM à utiliser:', fcmTokens);

      try {
        const responses = await admin.messaging().sendEach(messages);

        responses.responses.forEach((resp, index) => {
          if (resp.success) {
            console.log(`Message ${index + 1} envoyé avec succès`);
          } else {
            console.error(`Erreur pour le message ${index + 1}:`, resp.error?.message);
          }
        });

        notificationResult = {
          successCount: responses.responses.filter(r => r.success).length,
          failureCount: responses.responses.filter(r => !r.success).length
        };

      } catch (e) {
        console.error("Erreur inattendue FCM:", e);
        notificationResult = { error: "Erreur lors de l’envoi FCM", details: e.message };
      }
    }

    res.status(200).json({
      message: 'Message envoyé et conversation mise à jour',
      notification: notificationResult
    });

  } catch (error) {
    console.error('Erreur /send-message:', error);
    res.status(500).json({ error: 'Erreur lors de l’envoi du message' });
  }
});

//  Lancer le serveur
const PORT = process.env.PORT || 8000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 FCM server en écoute sur http://localhost:${PORT}`));
