FROM ${REPO}/almond/base

MAINTAINER Almond Admin <root@almond.stanford.edu>

# args can be set using --build-args, e.g.:
# --build-arg ALMOUND_CLOUD_VERSION=production
ARG ALMOND_CLOUD_VERSION=master
ARG DECANLP_VERSION=f5ea63ecb0abdd3bf50561b8f04a3aed6892e84f

RUN yum -y install \
        GraphicsMagick \
        systemd-devel \
        bubblewrap

# setup working dir
WORKDIR /var/lib/almond-nlp
COPY config_get.js config_get.js
COPY startup.sh startup.sh
RUN chmod 755 startup.sh
RUN chown -R almond-prod:almond-prod /var/lib/almond-nlp/
USER almond-prod

# install decanlp
RUN pip3 install --user "git+https://github.com/stanford-oval/decaNLP.git@${DECANLP_VERSION}#egg=decanlp"

# downlod source and install packages
WORKDIR /home/almond-prod
RUN mkdir src && cd src && \
    git clone --branch=${ALMOND_CLOUD_VERSION} https://github.com/stanford-oval/almond-cloud.git
WORKDIR /home/almond-prod/src/almond-cloud/
RUN yarn install
RUN pip3 install --user -r nlp/python_classifier/requirements.txt

WORKDIR /var/lib/almond-nlp

# download classifer
RUN mkdir -p classifier && \
    wget https://nnmaster.almond.stanford.edu/test-models/classifier1.tar.gz  && \
    tar xvf classifier1.tar.gz -C classifier && \
    rm -f classifier1.tar.gz

# embeddings will be downloaded form S3 at startup to reduce the size of this image.
ENV S3_DECANLP_EMBEDDINGS=s3://almond-training/embeddings.tar.gz
ENV DECANLP_EMBEDDINGS=/var/lib/almond-nlp/share/embeddings
RUN mkdir -p ${DECANLP_EMBEDDINGS}

# entry point
CMD ["/bin/bash", "-c", "/var/lib/almond-nlp/startup.sh"]
