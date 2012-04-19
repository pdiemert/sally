## Instructions ##

Start the simple web server:

    > node server.js

Start up at least one slave:

    > sally

Run load test (i.e. start the master):

    > sally loadtest.js


Note:

*  Any number of slaves can be run, use 'sally -m <host>' to tell the slave where the master is located, load is evenly distrubted among slave pool.
