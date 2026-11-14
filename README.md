# Mola

A virtual queue for walk-in offices: clinics, Home Affairs branches, campus financial-aid offices.

People lose hours standing in line because leaving the line means losing their place. With Mola you
scan a QR code at the door, get a number on your phone (no app, no account), and watch your position
update live. When you're called you have a few minutes to tap **Confirm**; if you don't, the queue
moves on and you drop back a few places.

## How it's built

Serverless on AWS, so an office that's closed costs nothing:

- **API Gateway WebSocket API** pushes live positions to phones and to a "now serving" screen.
- **DynamoDB** holds the queue, with an atomic counter for ticket numbers.
- **Step Functions**: each called ticket is one execution that waits on a `waitForTaskToken`
  callback for the confirm tap; a timeout drops the patron back and calls the next person.
- **Lambda** (Node.js 24, TypeScript) handles each WebSocket route.
- **S3 + CloudFront** serve the React frontend.

## Status

Design phase. No application code yet; deploy instructions arrive with the first deployable stack.
